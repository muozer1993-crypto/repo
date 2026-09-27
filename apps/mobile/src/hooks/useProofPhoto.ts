import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Platform } from 'react-native';

import { useToast } from '@/components/Toast';
import { useApi } from '@/hooks/useApi';
import type { ApiClient } from '@/lib/api';
import { errorText } from '@/utils/errors';

/**
 * Native FormData takes the `{ uri, name, type }` shape `api.uploadPhoto` builds;
 * a browser needs a real Blob, so the web path fetches the picked object URL first.
 */
async function uploadProof(api: ApiClient, asset: ImagePicker.ImagePickerAsset): Promise<string> {
  const guessed = asset.fileName?.trim();
  const name = guessed && /\.[a-z0-9]{3,4}$/i.test(guessed) ? guessed : 'kanit.jpg';
  if (Platform.OS === 'web') {
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    const form = new FormData();
    form.append('file', blob, name);
    const result = await api.request<{ url: string }>('POST', '/uploads', { formData: form });
    return result.url;
  }
  const result = await api.uploadPhoto(asset.uri, name);
  return result.url;
}

/**
 * Taking or choosing a proof photo and uploading it: the entry modal attaches
 * one to a new entry, the feed's "Kanıt ekle" answers an itiraz with one.
 *
 * `pick` resolves to the uploaded path, or null when the user backed out or a
 * permission was refused (a toast has already said why).
 */
export function useProofPhoto() {
  const api = useApi();
  const toast = useToast();
  const [uploading, setUploading] = useState(false);

  const pick = async (from: 'camera' | 'library'): Promise<string | null> => {
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
      const asset = result.assets[0];
      if (!asset) return null;

      setUploading(true);
      return await uploadProof(api, asset);
    } catch (err) {
      toast({ title: 'Fotoğraf gitmedi', body: errorText(err, 'Yükleme başarısız.'), kind: 'danger' });
      return null;
    } finally {
      setUploading(false);
    }
  };

  return { pick, uploading };
}
