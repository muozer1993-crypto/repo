# KOYDUM — nasıl çalışıyor

Bu belge kodun neden böyle bölündüğünü anlatır. API'nin harfi harfine sözleşmesi için
`SPEC.md`, kurulum için `README.md`.

## Üç parça

```
┌───────────────────┐        HTTPS/JSON        ┌────────────────────┐
│  apps/mobile      │ ───────────────────────► │  apps/server       │
│  Expo · React 19  │ ◄─────────────────────── │  Fastify · SQLite  │
└─────────┬─────────┘      Expo Push API       └─────────┬──────────┘
          │                      ▲                       │
          │                      └───────────────────────┘
          │
          └──────────► packages/shared ◄──────────────────┘
                       tipler · zod şemaları · puanlama
                       katalog · laflar · arayüz metinleri
```

`packages/shared` iki tarafın da **kaynak koddan** import ettiği bir pakettir; derleme adımı
yoktur. Metro (mobil) ve tsx (sunucu) TypeScript'i doğrudan okur. Bunun getirisi: bir alan adını
değiştirdiğinde iki taraf da aynı anda derlenmez, hata anında ortaya çıkar.

## Zaman ve günler

Bir çelınc "gün" üzerinden puanlanır ve gün, **kullanıcının kendi saat dilimine** göre hesaplanır
(`users.timezone`). İstanbul'daki biriyle Berlin'deki biri aynı çelıncta yarışırken herkesin
günü kendi yerel gece yarısında döner. Sunucu hiçbir zaman istemcinin gönderdiği saate güvenmez:

* `clientTime` sadece kayıt amaçlıdır, doğrulamada kullanılmaz.
* Check-in'in "geç mi" olduğuna sunucu kendi saatiyle karar verir.
* Geçmiş güne giriş penceresi (manuel 2 gün, adım 7 gün) sunucunun "şimdi"sine göredir.

Sunucudaki tek "şimdi" kaynağı `app.now()`'dur. Testler oraya kontrollü bir saat enjekte eder,
bu yüzden çelınc yaşam döngüsü gerçek zamana hiç bağlı değildir.

## Çelıncın ömrü

```
pending ──(başlangıç geldi, ≥2 kabul)──► active ──(bitiş geldi)──► finished
   │                                                                  │
   └──(kimse kabul etmedi / creator iptal etti)──► cancelled           │
                                                                      ▼
                                              kazanan KOYDUM MU? gönderir
                                              kaybeden rezillik ekranını görür
                                              herkes rövanş açabilir
```

Geçişleri 30 saniyede bir çalışan `services/scheduler.ts` yapar. Aynı fonksiyon
(`runSchedulerOnce`) testlerde ve `/dev/advance` ucunda doğrudan çağrılır, yani zamanlayıcı
davranışı beklemeden test edilebilir.

## Puanlama

`packages/shared/src/scoring.ts` saf bir fonksiyondur: girdi olarak çelınc tipi, gün listesi ve
girişler alır, sıralamayı döndürür. Veritabanına, tarihe veya ağa dokunmaz. Sunucu her yazma
sonrası bunu bellekte yeniden çalıştırır; kaydedilmiş bir "skor" alanı yoktur, sadece çelınc
kapanırken sonuç `challenge_participants.final_score` alanına yazılır.

Altı metrik türü vardır ve hepsi aynı arayüze oturur: `auto_steps`, `focus_minutes`,
`checkin_deadline`, `daily_boolean`, `manual_count`, `manual_lower_is_better`. Yeni bir çelınc
türü eklemek katalogda bir satır demektir — sunucu ve uygulama kodu değişmez.

İki istisna bilinsin. `manual_lower_is_better` (ekran süresi) toplam değil **günlük ortalama**
ile yarışır: girilmeyen gün en kötü değerden sayılır, toplam pencere gün sayısına bölünür. Böylece
saat dilimi yüzünden bir gün fazla penceresi olan oyuncu cezalandırılmaz ve katalogdaki "ortalaması
en düşük olan kazanır" cümlesi doğru olur. Çelınc sürerken pencere bugüne kadar kırpılır; ikinci
günde beş günlük "girilmedi" cezası gösterilmez, çelınc bitince tam pencere uygulanır (o an zaten
aynı şeydir). İkincisi: `manual_count` ve `focus_minutes` girişleri bir `sessionId` taşır ve aynı
kimlikle gelen ikinci istek yeni bir satır değil, ilk satırın kendisidir. Telefon her dokunuşta
yeni bir kimlik üretir; zaman aşımına uğrayıp çevrimdışı kuyruğundan tekrar gönderilen istek
böylece bir bardak suyu iki kez saymaz.

## Laf sokma zinciri

1. Çelınc biter, `winner_id` yazılır.
2. Kazanan `/challenges/:id/taunt` çağırır, isterse bir şablon seçer.
3. Sunucu şablonun seviyesini **alıcının** `vulgarity_max` değerine kırpar. Seviye 3 bir kanka,
   seviye 1 seçmiş birine ancak seviye 1 laf sokabilir.
4. Metin `renderTaunt` ile gerçek isim ve skorlarla doldurulur.
5. Bildirim satırı yazılır (inbox), sonra push kuyruğuna girer.

Push başarısız olsa bile laf inbox'ta durur. Uygulama 45 saniyede bir okunmamışları sorar ve
push gelmemiş bir öğe bulursa cihazın kendi yerel bildirimini üretir. Yani Expo Go'da bile
KOYDUM ulaşır, sadece anında değil.

## Gün ortası dürtme

Arkadaşın seni elle dürtebilir. Asıl mesele kimsenin bakmadığı anda gelen bildirim: zamanlayıcı
her turda aktif çelınclara bakar ve geride kalana "o ne lan, Mahmut sana 8.229 adım fark koymuş,
kalk da iki dolaş" der. Çelıncı bir skor tablosundan gün içinde peşini bırakmayan bir şeye
çeviren kısım burasıdır.

Spam olmaması dört kurala bağlı:

* `nudges_sent` tablosunun birincil anahtarı (`challenge_id`, `user_id`, `day_key`) doğrudan hız
  sınırıdır — `INSERT OR IGNORE` hiçbir şey değiştirmediyse bugün zaten dürtülmüş demektir;
* saat penceresi **okuyanın kendi saat dilimine** göre 12:00–22:00 arasıdır;
* fark, lideri skorunun en az onda biri kadar olmalıdır — 40 adımlık fark hikâye değildir;
* check-in çelınclarında ve son bir saatte hiç gönderilmez, oralarda zaten kendi hatırlatması var.

Kapanış cümlesi metriğe göre değişir: "kalk da iki dolaş" odak çelıncında saçmadır, orada
"telefonu bırak da bir seans yap" der.

## Haftanın hesabı

Her pazar akşamı 20:00'den sonra (okuyanın kendi saatiyle) zamanlayıcı herkese haftanın
özetini düşer: kaç kere koydun, kaç kere yedin, kaç adım attın, en iyi günün hangisiydi ve
kankalar arasında **haftanın kralı** kim. Tek bir çelınca değil gruba dair olan tek bildirim bu;
pazartesi sabahki laf atışmasını pazar akşamı başlatan kısım.

* `recaps_sent (user_id, week_key)` hız sınırıdır; `week_key` haftayı bitiren yerel pazardır.
* Sunucu bütün pazar akşamı kapalı kaldıysa özet pazartesi öğlene kadar yine gider, sonrasında
  gitmez — çarşamba gelen bir özet hiçbir şey anlatmaz.
* Sonuç penceresi bir önceki özetin gönderildiği andan şimdiye kadardır. Pazar 23:59'da biten bir
  çelınc bu yüzden ya bu haftaya ya da bir sonrakine girer, ikisine birden ya da hiçbirine değil.
  Önceki özet 7 günden biraz eskiyse de (pazartesi telafisi, saatlerin geri alındığı gece) pencere
  oradan başlar; ancak 9 günden eskiyse, yani bir hafta tamamen atlanmışsa, son 7 güne bakılır.
* Pazartesi sabahı giden telafi özeti yeni haftada okunur, o yüzden "bu hafta" yerine "geçen
  hafta", "haftaya rövanş" yerine "bu hafta rövanş" der.
* Kral önce galibiyete, eşitse haftalık adıma bakar; ikisi de birebir eşitse taht paylaşılır.
  En çok yürüyen ise sadece tek başına öndeyse söylenir.
* Anlatacak bir şey yoksa (biten çelınc yok, adım yok, süren çelınc yok, kankalardan kimse bir şey
  yapmamış) satır hiç yazılmaz.

Metin sunucuda, okuyanın seviyesinde yazılır; `data` ise sayıları ve hazır satırları taşır, gelen
kutusu bunları kutucuklu bir kart olarak çizer. `data` bozuksa kart yerine düz metin satırı çıkar.

## Rozet merdivenleri

Rozetler düz bir duvar değil, yedi **merdivendir**: koyuş, yiyiş, adım, odak, erken kalkma,
itiraz, rövanş. Her merdivenin basamakları sırayla açılır ve profil sadece kazandığın basamakları
artı bir üstünü çizer; daha yukarısı sen oraya gelene kadar hiç görünmez.

Sebebi basit: yirmi iki gri kare, yeni bir kullanıcıya "yapmadığın yirmi iki şey" listesi gösterir.
Bir sonraki basamak ise bu akşam ne yapacağını söyler. `badgeLadder(stats)` bu listeyi üretir,
`badgeLevel(family, earned)` de o merdivende kaçıncı basamakta olduğunu verir.

## Expo Go ve bildirimler

`expo-notifications` paketini Android'de Expo Go içinde **import etmek** hata fırlatır: paketin
ana dosyası, modül gövdesinde push token dinleyicisi kuran bir alt modülü yeniden dışa aktarır ve
push, Expo Go'dan SDK 53'te kaldırılmıştır. Modül değerlendirilirken atılan bir hata expo-router
için ölümcüldür — rota modülü `undefined` olur ve uygulama komple açılmaz.

Bu yüzden pakete dokunan tek yer `services/expoNotifications.ts`. Paketi çalışma anında,
`try/catch` içinde yükler; ana dosya reddederse *yerel* bildirim yüzeyini derin modüllerden
yeniden kurar (hiçbiri zehirli import'a uğramıyor). Sonuç: Expo Go'da Android'de kanal, izin,
hatırlatmalar ve laf sokma bildirimi çalışmaya devam eder, sadece push token'ı yoktur.

Bir de kural: `src/` altında `expo-notifications` adını başka hiçbir dosya yazamaz. Bunu bir test
zorlar (`__tests__/expoGo.test.ts`), çünkü bu hata bir daha geri gelirse uygulama açılmıyor.

## Uygulamanın katmanları

```
index.ts          giriş: expo-router + arka plan görevinin tanımı (başsız çalışma için)
src/app/          expo-router rotaları — sadece ekran, iş mantığı yok
src/hooks/        react-query sorguları ve mutasyonları
src/lib/api.ts    tek HTTP istemcisi; her uç burada tiplenmiş
src/services/     cihaza dokunan her şey: adım, bildirim, odak, arka plan, kuyruk
src/components/   tasarım sistemi
packages/shared   iki tarafın ortak dili
```

Cihaza dokunan her modül web'de de derlenir: `steps.ts` (web) ve `steps.native.ts` (cihaz)
çifti Metro tarafından platforma göre seçilir. Bu sayede `expo export --platform web` çalışır ve
uçtan uca test tarayıcıda koşabilir.

## Telefonun kendi okuduğu değerler

İki metrik elle girilmez, telefon söyler: adımlar ve (Android'de) ekran süresi. İkisi de aynı
kalıpla akar:

```
cihaz → services/stepSync.ts / screenTimeSync.ts → POST /me/steps | /me/screen-time
      → services/deviceSync.ts: steps_daily / screen_time_daily'ye yaz,
        kullanıcının oynadığı her uygun çelınca entry olarak dağıt (upsert)
```

Hangi çelınc tipinin hangi cihaz verisiyle dolduğunu katalog söyler (`ChallengeType.deviceMetric`:
`steps` ya da `screen_time`); sunucu tip anahtarlarını oradan okur, uygulama hiçbir zaman "hangi
çelınclar var" diye düşünmez. Dağıtım, `POST /challenges/:id/entries` ile aynı gün kurallarına
uyar (`dayWindowIssue`): pencere dışı, gelecek ya da 7 günden eski bir gün sessizce atlanır, ham
okuma yine de saklanır.

Cihaz kaynağı (`pedometer`, `health_connect`, `usage_stats`) elle yazılmış değerin üstüne yazar;
tersi yasaktır: telefonun okuduğu bir gün için `manual` yazmaya kalkan istek 409 `device_locked`
alır. Kanıt fotoğrafı da sadece `manual` için zorunludur.

Android'de adımın üç kaynağı var, sırayla: Health Connect (kuruluysa), Google Play hizmetlerinin
Recording API'si (`apps/mobile/modules/koydum-steps/`) ve uygulama açıkken sayım. Android 9'dan
beri arka plandaki bir uygulama adım sensöründen hiç olay almaz; bu yüzden uygulama kapalıyken
saymanın tek yolu, sayımı Play hizmetlerinin yapması. Kayıt ilk izin anında başlar; o günün
öncesini uygulamanın ön planda saydığı değer tamamlar, ikisinden büyük olan alınır.

Ekran süresinin Android tarafı `apps/mobile/modules/koydum-screen-time/` altında yerel bir Expo
modülüdür (Kotlin, `UsageStatsManager.queryEvents`). Uygulama onu adıyla arar
(`requireOptionalNativeModule('KoydumScreenTime')`), yoksa ya da izin verilmemişse sebebiyle
birlikte "okuyamıyorum" der ve ekran elle girişe döner. iPhone'da bu veri hiçbir uygulamaya
açık değildir; orada elle giriş kalıcıdır.

## Arka planda ne çalışır

`services/background.ts` on beş dakikada bir uyanan sistem görevini tanımlar. Uygulama açıkken
`NotificationBridge` bu göreve kendi işleyicisini verir; uygulama kaydırılıp kapatıldıktan sonra
görev **başsız** çalışır: JS paketi yüklenir ama React hiç kurulmaz, dolayısıyla hiçbir provider
yoktur. Bu durumda `services/backgroundWork.ts` oturumu doğrudan depodan okur ve aynı üç işi
yapar: adım ve ekran süresi okumalarını gönderir, çevrimdışı kuyruğunu boşaltır, gelen kutusu
sayısını rozete yazar. "Kimse uygulamayı açmasa da çelınc puan toplar" sözü buna dayanır.
Sırası gelmişse işe oturumu yenileyerek başlar (aşağıda "Oturumlar"): sadece bu görevle uyanan
bir telefon da 90. gün dışarıda kalmaz.

Görevin tanımı bu yüzden `_layout`'tan değil, uygulamanın giriş dosyasından gelir:
`apps/mobile/index.ts` (`package.json`'daki `main`) önce `expo-router/entry`'yi, sonra
`services/background`'u yükler. expo-router rota dosyalarını ancak ekranı çizerken değerlendirir,
başsız çalışmada da hiçbir şey çizilmez. Tanımı bulamayan expo-task-manager görevi kayıttan
siler; yani kapalı telefona "KOYDUM MU?" ve adım gönderimi, uygulama bir daha açılana kadar
sessizce dururdu.

Telefonun kendi çıkardığı bildirimler (`fireLocal`, hatırlatmalar) Android'de `koydum`
kanalına gider. Tetikleyicisi `null` olan bir bildirim kütüphanenin İngilizce "Miscellaneous"
kanalına düşer; orayı susturan biri bütün lafları da susturmuş olurdu. O yüzden hemen gösterilecek
bildirim de sadece `channelId` taşıyan bir tetikleyiciyle gönderilir.

## Oturumlar

Oturum, sunucunun imzaladığı durumsuz bir JWT'dir ve imzalandığı andan itibaren 90 gün geçerlidir.
Eskiden bunu yenileyen bir şey yoktu: aynı hafta katılan kankaların hepsi aynı gün dışarı
atılıyordu, arka plan görevi de 401'i yutup adım göndermeyi sessizce bırakıyordu. Şimdi
`services/session.ts` haftada bir, önce hangisi çalışırsa (uygulamanın açılışı ya da başsız
görev), `POST /auth/refresh` ile token'ı taze 90 günlükle değiştirir. Süresi dolmuş bir token
yenilenmez; yenileme içeride kalmanın yolu, geri girmenin değil. Yenileme sürerken çıkış yapan
birinin token'ı depoya geri yazılmaz. Sunucu yine de bir token'ı reddederse (401) uygulama çıkış
yapar ve giriş ekranı bir kereliğine "Oturumun düşmüş, bir daha gir." der; önceden hiçbir şey
demeden giriş ekranını gösteriyordu.

Şifre, Ayarlar → Hesap → "Şifreni değiştir"den değişir (`POST /me/password`). Yanlış girilen
mevcut şifre 401 değil 400 `wrong_password` döner, çünkü uygulama her 401'de çıkış yapar; bir
yazım hatası o anki oturuma mal olmamalı. Buradaki tahmin hakkı da girişteki kadardır: hesap
başına 15 dakikada 8 yanlış. Token'lar durumsuz olduğundan şifre değişince başka
telefonlarda açık oturumlar kapanmaz; bunun için sunucunun iptal listesi tutması gerekirdi.

## Neden SQLite

Bu uygulamanın kullanıcısı bir arkadaş grubudur, on binlerce kişi değil. Tek dosyalık bir
veritabanı yedeklemesi kolaydır (`cp koydum.db yedek.db`), ORM yoktur, migration'lar kodun
içinde string olarak durur ve açılışta bir transaction içinde uygulanır. Sorgu sayısı azdır ve
hepsi hazırlanmış ifadelerdir.

## Sunucuyu açanın araçları

E-posta yok, şifre sıfırlama bağlantısı da yok: bu bir arkadaş grubu, herkes sunucuyu açanı
tanır. Şifresini unutana yeni şifreyi o verir: `npm run yonet -- sifre ali` (`src/cli/yonet.ts`;
işin kendisi `services/admin.ts`'te). Komut sunucunun kullandığı veritabanı dosyasını ikinci bir
bağlantıyla açar. WAL ikinci bağlantıyı içeri alır, `busy_timeout` sunucunun yazmasını bekler;
yani sunucu açıkken çalışır. Oturumlar durumsuz JWT olduğundan yeni şifre açık oturumları
kapatmaz. Şikayetler de aynı yoldan okunur (`sikayetler`): uygulamada onları okuyan bir ekran yok,
sunucu her yeni şikayette kendi penceresine bir `warn` satırı düşer.
