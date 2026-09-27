/**
 * The pending invite: parked before sign-in, spent right after, never sent to
 * the wrong server, kept when the phone is offline, forgotten after a week.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ApiError, type ApiClient } from '@/lib/api';
import {
  applyPendingInvite,
  normalizeInviteCode,
  readPendingInvite,
  savePendingInvite,
  sendInvite,
} from '@/services/invite';
import { compareVersions, isLocalNetworkUrl, resolveServerUrl } from '@/utils/url';

function client(overrides: Partial<Record<'invite' | 'requestFriend', jest.Mock>> = {}) {
  const invite = overrides.invite ?? jest.fn(async () => ({ code: 'ABC234', inviter: { username: 'ali', displayName: 'Ali', avatarEmoji: '🐐' } }));
  const requestFriend = overrides.requestFriend ?? jest.fn(async () => ({ status: 'pending' as const }));
  return { api: { invite, requestFriend } as unknown as ApiClient, invite, requestFriend };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('invite codes', () => {
  it('normalises what a link or a keyboard produces', () => {
    expect(normalizeInviteCode(' abc234 ')).toBe('ABC234');
    expect(normalizeInviteCode('AB')).toBeNull();
    expect(normalizeInviteCode('ab-c23')).toBeNull();
    expect(normalizeInviteCode(undefined)).toBeNull();
  });
});

describe('pending invite', () => {
  it('is spent once, right after sign-in on the same server', async () => {
    await savePendingInvite('ABC234', 'http://192.168.1.142:4000/');
    const { api, requestFriend } = client();
    expect(await applyPendingInvite(api, 'http://192.168.1.142:4000')).toEqual({ kind: 'sent', name: 'Ali' });
    expect(requestFriend).toHaveBeenCalledWith({ inviteCode: 'ABC234' });
    expect(await readPendingInvite()).toBeNull();
    expect(await applyPendingInvite(api, 'http://192.168.1.142:4000')).toBeNull();
  });

  it('is dropped, not sent, when the account lives on another server', async () => {
    await savePendingInvite('ABC234', 'https://a.example.com');
    const { api, requestFriend } = client();
    expect(await applyPendingInvite(api, 'https://b.example.com')).toBeNull();
    expect(requestFriend).not.toHaveBeenCalled();
    expect(await readPendingInvite()).toBeNull();
  });

  it('survives an offline attempt and goes out on the next one', async () => {
    await savePendingInvite('ABC234', null);
    const offline = client({
      invite: jest.fn(async () => {
        throw new ApiError('network', 'Sunucuya ulaşamadım.', 0);
      }),
      requestFriend: jest.fn(async () => {
        throw new ApiError('network', 'Sunucuya ulaşamadım.', 0);
      }),
    });
    expect(await applyPendingInvite(offline.api, 'http://x')).toEqual({ kind: 'later' });
    expect(await readPendingInvite()).not.toBeNull();
    expect((await applyPendingInvite(client().api, 'http://x'))?.kind).toBe('sent');
  });

  it('is forgotten after a week', async () => {
    await savePendingInvite('ABC234', null);
    expect(await readPendingInvite(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))).toBeNull();
  });
});

describe('sendInvite outcomes', () => {
  const failing = (code: string, status: number) =>
    client({
      requestFriend: jest.fn(async () => {
        throw new ApiError(code, 'x', status);
      }),
    }).api;

  it('maps the server answers the screen has words for', async () => {
    expect((await sendInvite(failing('already_friends', 409), 'ABC234')).kind).toBe('already');
    expect((await sendInvite(failing('already_requested', 409), 'ABC234')).kind).toBe('already');
    expect((await sendInvite(failing('cannot_friend_self', 400), 'ABC234')).kind).toBe('self');
    expect(await sendInvite(failing('blocked', 403), 'ABC234')).toEqual({ kind: 'failed', message: 'x' });
    const accepted = client({ requestFriend: jest.fn(async () => ({ status: 'accepted' as const })) }).api;
    expect(await sendInvite(accepted, 'ABC234')).toEqual({ kind: 'accepted', name: 'Ali' });
  });

  it('calls a code nobody owns missing without asking to befriend it', async () => {
    const { api, requestFriend } = client({
      invite: jest.fn(async () => {
        throw new ApiError('invite_not_found', 'yok', 404);
      }),
    });
    expect(await sendInvite(api, 'ZZZZZZ')).toEqual({ kind: 'missing' });
    expect(requestFriend).not.toHaveBeenCalled();
  });
});

describe('url helpers', () => {
  it('resolves upload paths against the address this phone uses, old loopback links included', () => {
    expect(resolveServerUrl('/uploads/a.jpg', 'http://192.168.1.142:4000/')).toBe('http://192.168.1.142:4000/uploads/a.jpg');
    expect(resolveServerUrl('http://localhost:4000/uploads/a.jpg', 'http://192.168.1.142:4000')).toBe(
      'http://192.168.1.142:4000/uploads/a.jpg'
    );
    expect(resolveServerUrl('https://cdn.example.com/a.jpg', 'http://x')).toBe('https://cdn.example.com/a.jpg');
  });

  it('knows which links only open on the same Wi-Fi', () => {
    expect(isLocalNetworkUrl('http://192.168.1.142:4000')).toBe(true);
    expect(isLocalNetworkUrl('http://10.0.0.2:4000')).toBe(true);
    expect(isLocalNetworkUrl('https://koydum.example.com')).toBe(false);
    expect(isLocalNetworkUrl('https://abc.trycloudflare.com')).toBe(false);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
    expect(compareVersions('abc', '1.0')).toBe(0);
  });
});
