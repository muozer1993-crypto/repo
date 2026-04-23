# Windows'ta Yerel Geliştirme Kurulumu

Bu rehber Windows bilgisayarında uygulamayı çalıştırmak ve Android
telefonuna **hot reload** (kaydet → 1-2 saniyede telefon güncellensin)
ile bağlamak için adım adım kurulum anlatır.

APK kurma döngüsünden çıkmak için tek seferlik yatırım. Toplam ~45 dk.

---

## 1. Flutter SDK

1. https://docs.flutter.dev/get-started/install/windows adresinden
   **Flutter SDK** ZIP dosyasını indir (yaklaşık 1.5 GB).
2. ZIP'i `C:\src\flutter` klasörüne aç. (Klasör adı boşluk içermesin,
   `Program Files` gibi yerler **kullanma**.)
3. Windows arama → "Ortam Değişkenlerini Düzenle" → **Path** değişkenine
   `C:\src\flutter\bin` ekle.
4. Yeni bir PowerShell aç, şunu çalıştır:
   ```powershell
   flutter --version
   ```
   Versiyon basıyorsa ✓.

**Önemli**: Projemiz **Flutter 3.27.1** kullanıyor (CI burada pinli).
Farklı versiyon da çalışır ama hata olursa şunu çalıştır:
```powershell
flutter downgrade 3.27.1
```

## 2. Android Studio (sadece SDK + sürücüler için)

Android Studio'yu IDE olarak kullanmayacaksın (VSCode daha hafif) ama
Android SDK'yı kurmanın en kolay yolu bu.

1. https://developer.android.com/studio → **Android Studio** indir → kur.
2. İlk açılışta "Standard" kurulum seç, licenses kabul et.
3. Kurulum bitince kapatabilirsin.

## 3. Android licenses kabul et

PowerShell'de:
```powershell
flutter doctor --android-licenses
```
Her soruya `y` yaz.

## 4. Flutter doktor kontrol

```powershell
flutter doctor
```

Şu satırların yanında ✓ olmalı:
- [✓] Flutter
- [✓] Android toolchain
- [✓] Visual Studio (varsa opsiyonel, Windows masaüstü app için)

**"Android Studio" veya "Chrome" için X/warning**: sorun değil, biz
telefon için geliştiriyoruz.

## 5. VSCode + Flutter eklentisi (editör)

1. https://code.visualstudio.com/ indir → kur.
2. VSCode aç → sol kenarda Extensions (Ctrl+Shift+X).
3. Ara: **"Flutter"** → Dart-Code'un yayınladığı eklentiyi kur.
4. Bu otomatik olarak **Dart** eklentisini de getirir.

## 6. Git

Git yoksa https://git-scm.com/download/win → kur. Varsayılan ayarlar
yeterli.

## 7. Telefonu geliştirmeye hazırla (Android)

**Bir kerelik işlem**, sonra USB takınca tanınır:

1. Telefonda **Ayarlar → Telefon Hakkında → Yazılım Bilgisi**.
2. **"Yapı numarası"** satırını bul → 7 kez peş peşe dokun. "Artık
   geliştiricisin" mesajı çıkacak.
3. **Ayarlar → Geliştirici Seçenekleri**'ne gir.
4. İki şeyi aç:
   - **USB Hata Ayıklama** (USB Debugging)
   - **USB Üzerinden Yükleme** (varsa)
5. USB kablosuyla bilgisayara bağla.
6. Telefonda "Bu bilgisayara USB hata ayıklamasına izin ver?" popup'ı
   çıkar → "Her zaman izin ver" işaretle → **Tamam**.

Bağlantıyı doğrula:
```powershell
flutter devices
```
Telefonun modeli listelenmeli.

## 8. Repo'yu klonla

PowerShell'de istediğin bir klasöre gir:
```powershell
cd C:\projects
git clone http://127.0.0.1:PORT/git/muozer1993-crypto/repo ergoterapi
cd ergoterapi
git checkout claude/therapeutic-game-design-BAr6E
```

**Not**: Yukarıdaki URL benim sandboxım için geçerli. Sen GitHub'dan
klonlarken:
```powershell
git clone https://github.com/muozer1993-crypto/repo.git ergoterapi
cd ergoterapi
git checkout claude/therapeutic-game-design-BAr6E
```

## 9. Bağımlılıkları yükle

```powershell
flutter pub get
```

## 10. isar_flutter_libs namespace yaması (ZORUNLU)

Isar 3 artık bakım almadığı için her `flutter pub get` sonrası pub
cache'deki kopyaya tek satırlık patch uygulamak gerekir. Bu repo'da
bu işi yapan hazır bir script var:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fix_isar_namespace.ps1
```

"Tamam. Simdi 'flutter run' calistirabilirsin." yazdığını gör.

## 11. Kod üretimi (Isar `.g.dart` dosyaları)

```powershell
dart run build_runner build --delete-conflicting-outputs
```

## 12. Çalıştır

Telefon USB'de bağlıyken:
```powershell
flutter run
```

İlk build 2-3 dakika sürer (gradle indiriyor, derlenyor). Sonra
telefonunda uygulama açılır.

---

## Hot reload kullanımı

Terminal pencerede `flutter run` çalışır durumda iken:

- **r** bas → **hot reload** (1-2 sn). Kod değişikliği anında uygulanır,
  state korunur (örn. profil setup'taydıysan orada kalırsın).
- **R** bas → **hot restart** (3-5 sn). Uygulama yeniden başlatılır,
  state sıfırlanır.
- **q** bas → uygulamayı kapat.

VSCode içinde: **F5** ile debug modda çalıştırabilirsin, sağ üstte
hot reload/restart butonları da var.

**Tipik iş akışı:**
1. VSCode'da bir widget dosyasını değiştir, **Ctrl+S** ile kaydet.
2. Terminale geri dön, **r** bas (veya VSCode Flutter eklentisi
   otomatik hot reload yapar).
3. Telefonda değişiklik görünür.

## Değişiklik yapma → beni güncelleyip PR açma

Yerelde değişiklik yaptığında:
```powershell
git add -A
git commit -m "fix: ..."
git push
```
CI otomatik yeni APK üretir; istersen kendi telefonuna Release'den
indirip test edebilirsin. Ama gündelik geliştirme için hot reload
yeter.

## Sorun giderme

### `flutter doctor` "Unable to locate Android SDK"
Android Studio'yu açmadığın halde kurmuş olabilirsin. Bir kere açıp
ilk kurulum wizard'ını tamamla.

### `flutter run` "Build failed ... namespace not specified"
isar_flutter_libs patch'ini unutmuşsun. Adım 10'u çalıştır.

### `flutter run` Gradle uzun sürüyor / donuyor
İlk build için 5-10 dakika normal. Sonraki build'ler 10-30 saniyedir.

### Telefon `flutter devices`'te görünmüyor
- USB kablosunu değiştir (şarj kablosu veri taşımayabilir).
- Telefonda USB modu "Dosya Aktarımı (MTP)" veya "USB Debugging" olsun.
- USB hata ayıklama iznini bir kere reddetmişsen: ayarlardan "USB hata
  ayıklama yetkilerini sıfırla" → kabloyu çıkar, tak, yeni popup'ı onayla.

### "Connection refused" tipi USB hatası
Bilgisayarda Android USB Driver kurulu olmayabilir. Android Studio
kurmuşsan otomatik gelir; değilse https://developer.android.com/studio/run/win-usb

### `dart run build_runner build` çakışma uyarısı veriyor
```powershell
dart run build_runner build --delete-conflicting-outputs
```
`--delete-conflicting-outputs` flag'i eski üretilmiş dosyaları siler
ve temiz üretir. Her zaman bu flag'i kullanabilirsin.

---

## Kısa referans (sık kullanılan komutlar)

```powershell
# Her pull'dan sonra
flutter pub get
powershell -ExecutionPolicy Bypass -File scripts\fix_isar_namespace.ps1
dart run build_runner build --delete-conflicting-outputs

# Çalıştır (telefon USB bağlıyken)
flutter run

# Bağlı cihazları listele
flutter devices

# Analiz + format
flutter analyze
dart format .

# Temizlik (build'ler saçma davranırsa)
flutter clean
flutter pub get
powershell -ExecutionPolicy Bypass -File scripts\fix_isar_namespace.ps1
dart run build_runner build --delete-conflicting-outputs
flutter run
```
