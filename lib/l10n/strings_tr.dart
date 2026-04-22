/// All user-facing Turkish strings — single source of truth.
///
/// Keeping every string here (rather than scattered across widgets) makes
/// copy changes diff-reviewable and keeps the patient-facing tone
/// consistent.
class StringsTr {
  const StringsTr._();

  // Karşılamalar
  static const greetingSabah = 'Günaydın';
  static const greetingOglen = 'İyi öğlenler';
  static const greetingIkindi = 'İyi ikindiler';
  static const greetingAksam = 'İyi akşamlar';
  static const greetingDinlenme =
      'Şimdi dinlenme vakti — yarın sabah görüşmek üzere.';
  static const nightBypassLink = 'Yine de bir oyun oyna';

  // Ana ekran
  static const startButton = 'Başla';
  static const mainScreenTitle = 'Ergoterapi Oyunu';

  // Profil kurulum
  static const profileSetupTitle = 'Hoş geldiniz';
  static const profileNameLabel = 'Hastanın adı';
  static const profileNameHint = 'Ör. Ayşe';
  static const profileAgeLabel = 'Yaş aralığı';
  static const profileAgeUnder65 = '65 altı';
  static const profileAge65to74 = '65 – 74';
  static const profileAge75to84 = '75 – 84';
  static const profileAgeOver85 = '85 üstü';
  static const profileSaveButton = 'Kaydet';
  static const profileNameRequired = 'Lütfen bir isim girin.';

  // Oyun
  static const exitButton = 'Çıkış';
  static const exitConfirmTitle = 'Oyundan çıkmak istiyor musunuz?';
  static const exitConfirmOk = 'Evet, çık';
  static const exitConfirmCancel = 'Oyuna dön';

  static const speakerButtonLabel = 'Yönergeyi tekrar dinle';

  // Tamamlanma
  static const completionTitle = 'Aferin, harikasın!';
  static const completionBackHome = 'Ana ekrana dön';

  // Oryantasyon kartı
  static const orientationQuestion = 'Şimdi ne zamanı?';
  static const orientationWithClock = 'Saat %s. Şimdi ne zamanı?';

  // Ayarlar
  static const settingsTitle = 'Ayarlar';

  // Sahne başlıkları
  static const sceneSabah = 'Kahvaltı Hazırla';
  static const sceneOglen = 'Öğle Sofrasını Kur';
  static const sceneIkindi = 'Çay Saatini Hazırla';
  static const sceneAksam = 'Yatak Başını Düzenle';
}
