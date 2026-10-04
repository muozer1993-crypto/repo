import { normalizeServerUrl, stripTrailingSlash } from '@/lib/config';

describe('server URL normalisation', () => {
  it('adds the default port to a bare LAN address', () => {
    expect(normalizeServerUrl('192.168.1.20')).toBe('http://192.168.1.20:4000');
    expect(normalizeServerUrl('  10.0.0.5  ')).toBe('http://10.0.0.5:4000');
    expect(normalizeServerUrl('localhost')).toBe('http://localhost:4000');
    expect(normalizeServerUrl('macbook.local')).toBe('http://macbook.local:4000');
  });

  it('keeps a port the user typed', () => {
    expect(normalizeServerUrl('192.168.1.20:8080')).toBe('http://192.168.1.20:8080');
  });

  it('leaves a real hostname on its default port', () => {
    expect(normalizeServerUrl('https://koydum.example.com')).toBe('https://koydum.example.com');
    expect(normalizeServerUrl('http://koydum.example.com')).toBe('http://koydum.example.com');
  });

  it('reads a bare domain as https and a bare LAN address as http', () => {
    // a tunnel only answers on https; as http it never reached the server
    expect(normalizeServerUrl('abc.trycloudflare.com')).toBe('https://abc.trycloudflare.com');
    expect(normalizeServerUrl('koydum.example.com/')).toBe('https://koydum.example.com');
    expect(normalizeServerUrl('192.168.1.20')).toBe('http://192.168.1.20:4000');
    expect(normalizeServerUrl('macbook')).toBe('http://macbook:4000');
    // a port typed by hand is a Node process on plain http
    expect(normalizeServerUrl('koydum.example.com:4000')).toBe('http://koydum.example.com:4000');
  });

  it('keeps a path prefix and drops the trailing slash', () => {
    expect(normalizeServerUrl('https://example.com/api/')).toBe('https://example.com/api');
  });

  it('rejects nonsense', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('http://')).toBeNull();
  });

  it('strips trailing slashes', () => {
    expect(stripTrailingSlash('http://x:4000///')).toBe('http://x:4000');
    expect(stripTrailingSlash('http://x:4000')).toBe('http://x:4000');
  });
});
