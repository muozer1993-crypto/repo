import { LIMITS } from '@koydum/shared';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Platform } from 'react-native';

import { useToast } from '@/components/Toast';
import { useApi } from '@/hooks/useApi';
import { ApiError, UPLOAD_TIMEOUT_MS, type ApiClient } from '@/lib/api';
import { errorText } from '@/utils/errors';

/**
 * Native FormData takes the `{ uri, name, type }` shape `api.uploadPhoto` builds;
 * a browser needs a real Blob, so the web path fetches the picked object URL first.
 * Both get the upload's long timeout, not the 15 s of a JSON call.
 */
async function uploadProof(api: ApiClient, asset: ImagePicker.ImagePickerAsset): Promise<string> {
  const guessed = asset.fileName?.trim();
  const name = guessed && /\.[a-z0-9]{3,4}$/i.test(guessed) ? guessed : 'kanit.jpg';
  if (Platform.OS === 'web') {
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    const form = new FormData();
    form.append('file', blob, name);
    const result = await api.request<{ url: string }>('POST', '/uploads', {
      formData: form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    return result.url;
  }
  const result = await api.uploadPhoto(asset.uri, name);
  return result.url;
}

/**
 * A photo the server would turn away for its size (413 `file_too_large`), caught
 * before it spends up to two minutes going up. Only where `fileSize` is the file
 * that is sent: on Android expo-image-picker reports the original's size, from
 * before its own quality 0.6 pass, so a 7 MB camera original that goes up as
 * 2 MB would be refused for nothing. There the server's 413 says it instead.
 */
function overUploadLimit(asset: ImagePicker.ImagePickerAsset): boolean {
  return Platform.OS !== 'android' && typeof asset.fileSize === 'number' && asset.fileSize > LIMITS.UPLOAD_MAX_BYTES;
}

export interface PickedProof {
  /** the server path, once the photo went up */
  url: string | null;
  /** the photo on this phone, when it could not go up for lack of a connection (`keepOffline` only) */
  localUri: string | null;
}

/**
 * Taking or choosing a proof photo and uploading it: the entry modal attaches
 * one to a new entry, the feed's "Kanıt ekle" answers an itiraz with one.
 *
 * `pick` resolves to the uploaded path, or null when the user backed out, a
 * permission was refused, the photo is over the upload limit or the upload
 * failed (a toast has already said why).
 *
 * With `keepOffline` (the entry modal, on a phone) a photo that could not go up
 * for lack of a connection comes back as `localUri` instead: the entry is
 * parked with it and the offline queue uploads it later. The feed's answer to
 * an itiraz stays online-only; it has no queue behind it.
 */
export function useProofPhoto(options: { keepOffline?: boolean } = {}) {
  const { keepOffline = false } = options;
  const api = useApi();
  const toast = useToast();
  const [uploading, setUploading] = useState(false);

  const pick = async (from: 'camera' | 'library'): Promise<PickedProof | null> => {
    let asset: ImagePicker.ImagePickerAsset | undefined;
    try {
      if (from === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) {
          toast({ title: 'Kamera izni yok', body: 'Ayarlardan kamerayı aç, sonra dene.', kind: 'danger' });
          return null;
        }
      } else if (Platform.OS !== 'web') {
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          toast({ title: 'Galeri izni yok', body: 'Ayarlardan fotoğraf iznini aç.', kind: 'danger' });
          return null;
        }
      }

      const result =
        from === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.6 })
          : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
      if (result.canceled) return null;
      asset = result.assets[0];
      if (!asset) return null;
      if (overUploadLimit(asset)) {
        toast({
          title: 'Fotoğraf çok büyük',
          body: "Bu fotoğraf 5 MB'tan büyük, sunucu almaz. Kamerayla yeniden çek ya da fotoğrafın ekran görüntüsünü alıp onu seç.",
          kind: 'danger',
        });
        return null;
      }

      setUploading(true);
      return { url: await uploadProof(api, asset), localUri: null };
    } catch (err) {
      // The picker's own cache file, not a copy: the OS may clear that cache
      // before the connection comes back, and the queue drops the photo then.
      // A browser's object URL would not outlive the page at all.
      if (keepOffline && asset && Platform.OS !== 'web' && err instanceof ApiError && err.isNetwork) {
        return { url: null, localUri: asset.uri };
      }
      toast({ title: 'Fotoğraf gitmedi', body: errorText(err, 'Yükleme başarısız.'), kind: 'danger' });
      return null;
    } finally {
      setUploading(false);
    }
  };

  return { pick, uploading };
}
