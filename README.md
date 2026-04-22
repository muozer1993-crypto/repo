# Ergoterapi — ADL Oyunu

Hafif bilişsel bozukluk (MCI) olan hastalar için tablette oynanan, günün saatine
göre değişen günlük yaşam aktivitesi (ADL) oyunu. Errorless Learning, Spaced
Retrieval ve Task-Oriented yaklaşımlar üzerine inşa edilmiştir.

Tam tasarım kararları için bkz.
`/root/.claude/plans/ergoterapi-teorileri-zerine-in-a-sequential-tulip.md`.

## Başlangıç

```bash
# Native iOS/Android shell'leri oluştur (ilk kez)
flutter create --platforms=ios,android --org tr.ergoterapi .

# Bağımlılıklar
flutter pub get

# Isar tiplerini üret
dart run build_runner build --delete-conflicting-outputs

# Çalıştır (Android tablet emülatörü veya iPad simülatörü)
flutter run --dart-define=SUPABASE_URL=https://<ref>.supabase.co \
            --dart-define=SUPABASE_ANON_KEY=<anon-key> \
            --dart-define=THERAPIST_EMAIL=therapist@clinic.tr

# Test
flutter test
```

## Konfigürasyon (build-time)

Üç zorunlu `--dart-define`:

| Anahtar | Açıklama |
|---|---|
| `SUPABASE_URL` | EU region projesi URL'si |
| `SUPABASE_ANON_KEY` | Anonim auth için |
| `THERAPIST_EMAIL` | Bu binary'nin rapor göndereceği terapist adresi |

Her hasta/terapist çifti için **ayrı APK/IPA** build edilir.

## Supabase

`supabase/` klasörü migrasyonları ve Edge Function'ı içerir:

```bash
cd supabase
supabase init               # ilk kez
supabase db push            # migrasyonları uygula
supabase functions deploy send-weekly-report
supabase secrets set RESEND_API_KEY=re_xxx
```

## Asset Rehberi (özet)

`assets/images/` altındaki tüm illüstrasyonlar:
- **Tipik örnek** kuralı: nesnenin en sık karşılaşılan formu (Türk çay
  bardağı, beyaz peynir bloğu, siyah zeytin tabağı).
- Soyut/minimalist çizim yasak.
- Şeffaf PNG, 512–1024 px, gölgesiz.
- Çeldiriciler aynı stil tutarlılığında çizilir.

Production illüstrasyon eklenmeden önce **tipiklik kontrol**: 2 yetişkin
(60+) gönüllüye 5 sn gösterip adlandırma; ≥%80 doğru tanıma → kabul.
Sonuç PR description'a yazılır.
