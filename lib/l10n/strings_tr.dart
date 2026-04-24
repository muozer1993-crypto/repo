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

  // v2 — geçiş ekranı (Game-1 → Game-2)
  static const transitionHeadline = 'Aferin! Şimdi ikinci oyuna geçelim.';
  static const transitionContinue = 'Devam';
  static const transitionSkip = 'Şimdilik yeterli';

  // v2 — Game-2 tipleri (başlıklar)
  static const game2PlateMatchingTitle = 'Tabağa Yerleştir';
  static const game2SequenceOrderingTitle = 'Sırayı Düzene Koy';
  static const game2QuantityCountingTitle = 'Kaç Tane Var?';
  static const game2NextStepPlanningTitle = 'Sıradaki Adım';

  // v2 — bonus
  static const bonusOfferTitle = 'Harika gittin!';
  static const bonusOfferBody = 'Bir bonus oyun daha keyif almak ister misin?';
  static const bonusOfferAccept = 'Evet, oynayalım';
  static const bonusOfferDecline = 'Hayır, teşekkürler';
  static const bonusFinishedBackHome = 'Ana ekrana dön';

  // v2 — gece ekranı
  static const nightBonusHeadline = 'Yumuşak bir an';
  static const nightBonusBody = 'Yıldızlara dokunarak yavaşla.';

  // v2 — onboarding / bakım veren daveti
  static const onboardingTitle = 'Seni bekliyoruz';
  static const onboardingBody =
      'Bu uygulamayı günde dört kez (sabah, öğlen, ikindi, akşam) '
      'açmaya çalışın. Bakım veren biri yanınızda varsa onu '
      'eşlik etmeye davet edebilirsiniz.';
  static const onboardingStart = 'Şimdi başla';
  static const onboardingInvite = 'Eşlik et';
}
