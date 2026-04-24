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

### v2 — Genişletilmiş asset listesi

v2 yükseltmesiyle dört ana dilim sahnesi artık ≥12 itemlık `itemPool`
taşıyor (rotasyonun bağımsızlaşabilmesi için). Toplam placeholder asset
ihtiyacı yaklaşık **~80 PNG** (48 hedef + ~30 çeldirici):

| Dilim | Hedefler (5) | Yeni hedefler (v2) | Çeldiriciler (7) |
|---|---|---|---|
| sabah | peynir, zeytin, çay, ekmek, **bal** | bal | terlik, diş fırçası, makarna, çorba, pilav, kahve fincanı, margarin |
| oglen | çorba, tavuk, salata, su, **ayran** | ayran | havlu, tarak, kek, bal, kurabiye, çay bardağı, sandviç |
| ikindi | demlik, çay bardağı, şekerlik, pasta | — | gözlük, mendil, limonata, ayran, süt, meyve, cezve, tuzluk |
| aksam | okuma gözlüğü, lamba, bardak, kitap | — | şemsiye, anahtar, kalem, defter, fotoğraf, saat, güneş gözlüğü, mum |

Ayrıca 4 Game-2 widget + 5 bonus sahnesi için ek asset'ler:

- **Game-2 (4 tip)**: widget'ların çoğu mevcut sahne asset'lerini tekrar
  kullanır; yalnız `quantity_counting` için tile-boyutu (96×96)
  thumbnail versiyonlar opsiyonel.
- **Bonus sahneleri** (`assets/images/scenes/bonus/`): `bonus_sabah_pair`
  (6 item), `bonus_oglen_find` (6), `bonus_ikindi_tap` (4 ışık),
  `bonus_aksam_explore` (5), `bonus_night_explore` (2 yıldız + ay +
  bulut). Gece varyantı koyu zemin için PNG'ler beyaz/ışıklı olmalı.
- **4 Game-2 yönerge sesi** (`assets/audio/instructions/<scene>_game2.wav`)
  ve 4 bonus yönerge sesi (`bonus_<scene>.wav`).

Tipiklik kontrol kuralı (60+ yaşlı 2 kişi, ≥%80 tanıma) yeni asset'lere
de uygulanır.

## v2 Yapı Özeti

Tek oturum artık `orientation → game1 → transition → game2 → completion
→ (opsiyonel) bonus` akışını çalıştırır. Akış yöneticileri:

- `lib/features/game/application/game_session_controller.dart` — üst
  katman state machine. Tek `SessionLog` satırı yazar (Game-1 + Game-2
  birleşik metrikler).
- `lib/features/game/application/scene_controller.dart` — Game-1 state
  machine. `deferWrite=true` iken kendini Isar'a yazmaz; session
  controller batch yazımı yapar.
- `lib/features/game/presentation/widgets/games/*` — 4 Game-2 widget'ı.
- `lib/features/game/presentation/widgets/bonus/*` — 4 bonus widget'ı.
- `lib/features/progress/application/scheduler_controller.dart` — ilk
  72 saat öğrenme fazı, dilim × gün bonus rotasyonu, item combo hash
  takibi.
- `lib/features/progress/application/missed_slot_detector.dart` —
  uygulama açılışında kaçırılan dilim tespiti.

Supabase tarafı: migration `0002_v2_upgrade.sql` yeni kolonlar ve
`bonus_plays` / `missed_slots` tabloları ekler. Edge Function
`send-weekly-report` yeni metrikler, iki ek CSV eki ve PDF bölümleri
üretir.
