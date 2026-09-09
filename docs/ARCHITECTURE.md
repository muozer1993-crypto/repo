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

## Neden SQLite

Bu uygulamanın kullanıcısı bir arkadaş grubudur, on binlerce kişi değil. Tek dosyalık bir
veritabanı yedeklemesi kolaydır (`cp koydum.db yedek.db`), ORM yoktur, migration'lar kodun
içinde string olarak durur ve açılışta bir transaction içinde uygulanır. Sorgu sayısı azdır ve
hepsi hazırlanmış ifadelerdir.
