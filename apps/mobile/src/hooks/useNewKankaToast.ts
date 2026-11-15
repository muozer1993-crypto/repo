import type { ChallengeSummary, InvitableChallenge, PublicUser } from '@koydum/shared';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';

import { useToast } from '@/components/Toast';
import { qk } from '@/lib/query';
import { useLevel } from '@/store/auth';
import { stillJoinable } from '@/utils/joinWindow';
import { byLevel } from '@/utils/levelCopy';

/**
 * The çelınc a kanka I just accepted could still be called into: the first the
 * server named (`invitable`, soonest end first), or, from a server too old to
 * send the list, the first of my cached çelınclar that I play in, that still
 * takes players and that they are not on (a "Reddet" may be asked again, as in
 * "Kanka ekle"). An empty list from the server means none, cache or not.
 */
export function invitableForNewKanka(
  invitable: readonly InvitableChallenge[] | undefined,
  cached: readonly ChallengeSummary[] | undefined,
  friendId: string,
  clock: number
): { id: string; title: string } | null {
  if (invitable) return invitable[0] ?? null;
  const open = (cached ?? [])
    .filter(
      (summary) =>
        summary.me?.status === 'accepted' &&
        stillJoinable(summary.challenge, clock) &&
        !summary.participants.some((p) => p.user.id === friendId && p.status !== 'declined')
    )
    .sort((a, b) => Date.parse(a.challenge.endsAt) - Date.parse(b.challenge.endsAt));
  const first = open[0];
  return first ? { id: first.challenge.id, title: first.challenge.title } : null;
}

/**
 * "Kanka oldunuz" after a "Kabul". The newcomer is usually who a running group
 * çelınc of mine was waiting for, and "Aç bir çelınc" split that group: with
 * such a çelınc the toast names it, and the tap opens its "Kanka ekle" with
 * the new kanka ticked. `otherwise` is the screen's own line for when there is
 * none.
 */
export function useNewKankaToast(): (
  friend: PublicUser,
  invitable: readonly InvitableChallenge[] | undefined,
  otherwise: string
) => void {
  const toast = useToast();
  const level = useLevel();
  const queryClient = useQueryClient();
  return (friend, invitable, otherwise) => {
    const cached = queryClient.getQueryData<ChallengeSummary[]>(qk.challenges());
    const open = invitableForNewKanka(invitable, cached, friend.id, Date.now());
    if (!open) {
      toast({ title: 'Kanka oldunuz', body: otherwise, kind: 'success' });
      return;
    }
    const name = friend.displayName;
    toast({
      title: 'Kanka oldunuz',
      body: byLevel(
        level,
        `${name} artık listende. “${open.title}” çelıncına davet edebilirsin.`,
        `${name} artık listende. “${open.title}” çelıncına çağır, grubu bölme.`,
        `${name} geldi 🍆 “${open.title}” çelıncına çek, o da yesin.`
      ),
      kind: 'success',
      // a tap is the point of this one: give it time
      durationMs: 8000,
      onPress: () => router.push({ pathname: '/challenge/[id]', params: { id: open.id, invite: friend.id } }),
    });
  };
}
