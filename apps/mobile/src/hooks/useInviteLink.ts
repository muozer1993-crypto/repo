import { useServerInfo } from '@/hooks/queries';
import { useAuth } from '@/store/auth';
import { isLocalNetworkUrl, isLoopbackUrl } from '@/utils/url';

export interface InviteLink {
  /** `<server>/davet/<my code>`; null until /me has brought the code. */
  link: string | null;
  /** The address only means this very device: the link opens on no other phone. */
  isLoopback: boolean;
  /** A home-network address: the link opens only for whoever is on the same Wi-Fi. */
  isLocal: boolean;
}

/**
 * My invite link, as Kankalar → Paylaş and the results screen's "Gruba at"
 * both send it.
 *
 * The page this link opens is served by our own server: it names the inviter,
 * opens the app with the right address, and offers the APK. When the server is
 * on the internet (npm run internet) its public address goes into the link even
 * if this phone reaches it over the home Wi-Fi.
 */
export function useInviteLink(): InviteLink {
  const inviteCode = useAuth((s) => s.me?.inviteCode ?? null);
  const serverUrl = useAuth((s) => s.serverUrl);
  const serverInfo = useServerInfo();
  const base = (serverInfo.data?.publicUrl ?? serverUrl).replace(/\/+$/, '');
  const isLoopback = isLoopbackUrl(base);
  return {
    link: inviteCode ? `${base}/davet/${inviteCode}` : null,
    isLoopback,
    isLocal: !isLoopback && isLocalNetworkUrl(base),
  };
}
