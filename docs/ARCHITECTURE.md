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
   │                                       │                          │
   │ kimse kabul etmedi                    │ herkes kaçtı             ▼
   │ creator iptal etti                    │          kazanan KOYDUM MU? gönderir
   │ herkes kaçtı                          │          kaybeden rezillik ekranını görür
   └──────────────► cancelled ◄────────────┘          herkes rövanş açabilir
```

Geçişleri 30 saniyede bir çalışan `services/scheduler.ts` yapar. Aynı fonksiyon
(`runSchedulerOnce`) testlerde ve `/dev/advance` ucunda doğrudan çağrılır, yani zamanlayıcı
davranışı beklemeden test edilebilir.

Zamanlayıcıyı beklemeyen iki iptal var: açanın kendi iptali ve "herkes kaçtı". İkincisinde bir ret,
bir ayrılma ya da bir hesap silme çelıncta kabul etmiş ya da hâlâ davetli iki kişi bırakmazsa çelınc
o istekle birlikte iptal olur (`cancelIfAbandoned`). Yoksa reddedilmiş bir teke tek, açanı bir hafta
"önde" yürütür, sonunda da "kimse kabul etmedi" diye kapanırdı. Davetli biri hâlâ kabul edip iki
kişi yapabilecekse bekler. Reddeden açana, ayrılan içeride kalanlara haber verir ("Ali tırstı,
reddetti", "Ali havlu attı"), engelli ikiliye hiçbir şey gitmez. Bitişten sonra ikisi de sessizdir
ve iptal etmez: o bekleyişte sonuç zamanlayıcınındır, kaybeden kimse ayrılıp sonucu bozamaz.
Reddetmek de son söz değildir: çelınc sürdükçe reddeden kabul edebilir, uygulama bunu çelınc
ekranında "Katıl" diye sunar. Oynayıp ayrılan geri giremez (`already_left`): herkese "havlu attı"
dendi, itiraz çoğunluğu da ona göre küçüldü. Sessiz bir davetli yüzünden bitişe kadar açık kalıp
tek kişiyle biten çelınc da zamanlayıcıda "herkes kaçtı" diye kapanır, kabul edip giden biri
varsa "kimse kabul etmedi" yazmaz.

Çelıncı açan, çelınc sürerken kanka da ekleyebilir (`POST /challenges/:id/invite`): uygulamayı
herkes aynı gün kurmuyor, ikinci gün gelen kanka için açılan ikinci bir çelınc grubu böler. Eklenen,
sihirbazda seçilmiş gibi `invited` girer ve aynı kapıdan kabul eder. Kapı da ikisi için aynı anda
kapanır (`acceptClosesAt`: bitişten bir saat önce, kısa çelıncta sürenin son dörtte biri); kabul
edilemeyecek bir davet boş bir bildirimdir. Bitişten sonraki bekleyişte kimse eklenmez. Reddeden
yeniden çağrılabilir ve yeni bir davet bildirimi alır; oynayıp ayrılan çağrılamaz, kabul kuralıyla
aynı sebepten.

Rövanş, eskisi kaç yerel gün sürdüyse o kadar gün sürer ve sihirbaz gibi açanın saat diliminde bir
günün son milisaniyesinde biter. Önceden "şimdi + eski süre" ile düğmeye basılan saatte bitiyordu;
yarıda kesilen son günün sonradan gelen telefon sayısı bitişten sonra atılan adımları da taşırdı.
Reddedilen (yani iptal olan) bir rövanş yenisini açmaya engel değildir.

Adımı ya da ekran süresini telefonun kendisinin saydığı çelınclar bitişte hemen kapanmaz. Son
akşamın adımları telefonda bir sonraki arka plan senkronunu bekler (15 dakika ve üstü), gece
yarısı kapatırsak kazananı eksik sayıyla seçeriz ve sonradan gelen adımlar çöpe gider. Bu yüzden
çelınc bir saat daha `active` kalır: telefonlar son günü göndermeye devam eder, elle giriş ise
bitişten itibaren kabul edilmez (`challenge_ended`). Herkesin telefonu son günü bitişten sonra
gönderdiyse beklemeden kapanır. Sunucu bitişte kapalıysa bir saat açıldığı andan sayılır
(`bootAt`). Elle girilen çelınclar tam bitişte kapanır. Bitişten sonra yalnızca bitişte bitmiş
günler değişebilir (`dayOverByEnd`): bitiş bir günü yarıda kestiyse (başka saat dilimindeki bir
oyuncu, eski usul 24 saatlik bir çelınc) o günün sonraki okuması bitişten sonra atılan adımları
da taşır, o yüzden gün bitişteki haliyle kalır ve o oyuncu beklenmez. Bekleyişte dürtme de yoktur:
"hâlâ açık, sıra sende" yalan olurdu.

İtiraz tek başına bir girişi silmez. Diğer oyuncuların çoğunluğu itiraz edince girişin sahibine
12 saat (`LIMITS.DISPUTE_ANSWER_MS`) tanınır ve giriş bu sürede sayılmaya devam eder; yoksa teke tek
çelıncta kaybeden taraf rakibinin her gününü tek dokunuşla sıfırlayabilirdi. Sahibi fotoğraf eklerse
itirazlar `dismissed` olur. Eklemezse zamanlayıcının `resolveDisputes` adımı (bitirmeden hemen önce
çalışır) girişi `rejected` yapar ve itiraz edenlerin `disputesWon` sayısı artar. Süre çoğunluğun
oluştuğu andan başlar, ilk itirazdan değil, ve girişin üstüne yazılır (`entries.answer_by`,
`syncDisputeClocks`). Her geçişte oyuncu sayısından yeniden hesaplanınca biri ayrılıp çoğunluk
küçüldüğünde eski bir itirazın süresi saatler önce dolmuş sayılıyor, giriş haber verilmeden
atılıyordu. Artık ayrılma, hesap silme ve zamanlayıcının her turu saati o andan tam 12 saatle
kurar ve sahibine söyler; `answer_by`'ı olmayan eski bir veritabanında da ilk tur böyle yapar.
Ayrılan birinin itirazı sayılmaz. Eski uygulamada "Kanıt ekle" yoktur: günü fotoğrafla yeniden
göndermek de itirazı cevaplar. Fotoğrafla kapanan ya da geri çekilen itirazın sahibi, giriş
sayısını ya da fotoğrafını değiştirince yeniden itiraz edebilir. Bitişte süresi dolmamış bir itiraz
varsa çelınc o süre boyunca `active` kalır; yoksa son dakika gelen bir itiraz, sahibine söz verilen
12 saati yerdi. Bu bekleyişte yeni itiraz alınmaz (adım ve ekran süresi çelınclarının bir saati
hariç, son akşamın sayıları o saatte gelir; `disputesCloseAt`), yoksa art arda açılan itirazlar
sonucu günlerce bekletebilirdi. Bitişten sonra ayrılmak da kapalıdır: teke tek çelıncta kaybeden
ayrılıp sonucu iptal ettirebilirdi.

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

Hangi laf havuzundan seçileceği her kaybeden için ayrı belirlenir (`tauntContextFor`). Rövanşı
ilk çelıncı kaybeden aldıysa `revenge`. Aynı kankayı üst üste üçüncü kez yendiysen `streak`: arada
bir beraberlik, bir kayıp ya da başkasının kazandığı ortak bir çelınc seriyi bozar ve sayım bu
çelınctan geriye yapılır (`winStreakAgainst`). Geç atılan bir laf, sonradan gelen galibiyetleri
de saymaz. İkisi de değilse farka bakılır: `win_big`, `win` ya da `win_close`. Sonuç ekranı bu
kelimeyi kazanana her kaybeden için `tauntContexts` ile verir. Seçici RÖVANŞ ve SERİ laflarını
ancak böyle gösterebilir, çünkü telefon yalnızca skorları bilir.

Rövanş eski kadroyu olduğu gibi çağırmaz, `POST /challenges` ile aynı kapıdan geçer. Hâlâ kanka
olanlar davet edilir; engelli ikili ve silinen hesaplar dışarıda kalır. Grup çelıncında başkası
üzerinden tanıştığın biri bu yüzden rövanşa gelmez. Sonuç ekranı bunu önceden söyler
(`rematchLeftOut`): rövanş düğmesinin altında "Veli kankan değil, rövanşa çağrılmaz" yazar ve
final tablosundaki adına dokununca profili açılır, oradan eklenir. Engeller listede yoktur:
eklemekle çözülmezler, sana konan bir engel de görünmemeli.

Push başarısız olsa bile laf inbox'ta durur. Uygulama 45 saniyede bir okunmamışları sorar ve
push gelmemiş bir öğe bulursa cihazın kendi yerel bildirimini üretir. Yani Expo Go'da bile
KOYDUM ulaşır, sadece anında değil.

Yeni bir satır gelince (push ya da bu yoklama) açık ekranlar da tazelenir
(`invalidateForNotifications`): gelen kutusu ve rozet her zaman, kanka isteğinde Kankalar,
çelınca dair bir satırda çelınc listeleri, o çelıncın detayı ve sonucu. Sekmeler açık kalır ve odağa
dönünce kendiliğinden yenilenmez; o yüzden Gelen, rozetin gördüğü en yeni satır kendi en
üstündeki değilse kendini yeniler, Kankalar da listesi 20 saniyeden eskiyse sekmeye dönünce.
Bir bildirime dokunmak onu okunmuş sayar: push da telefonun kendi kopyası da satırın
`notificationId`'sini taşır.

Gelen kutusu 30'ar satırlık sayfalarla gelir; listenin dibine inince bir eski sayfa istenir.
Sunucu `created_at < before` ile keser, zamanlayıcının tek bir turu da aynı kişiye aynı
milisaniyede birkaç satır yazabilir (bitiş, rozet, laf). İmleç son satırın kendi anı olsaydı
sayfa sınırına denk gelen kardeşi kaybolurdu; o yüzden bir milisaniye sonrası gönderilir ve
sınırda iki kere gelen satır ekranda bir kere gösterilir. Yeni bir satır gelince yüklenmiş bütün
sayfalar baştan okunur.

Zincirin zayıf halkası 2. adım: laf ancak kazanan uygulamayı açıp gönderirse var. Gece 23:59'da
biten çelınc kazanan uyurken kapanır, üşengeç kazanan hiç açmaz; kaybeden de "daha ağzını açmadı"
yazısına bakar durur. Bu yüzden bitişten 2 saat sonra hâlâ laf yememiş bir kaybeden varsa,
zamanlayıcının `sendTauntFollowups` adımı kazanana tek bir hatırlatma gönderir: "Koymayacak
mısın? Veli ağzını açmanı bekliyor." Kurallar:

* çelınc başına bir kez; `taunt_followups (challenge_id, stage)` tablosu hak talebidir;
* yalnızca kazananın kendi saatiyle 12:00–22:00 arasında (dürtmeyle aynı pencere). Saat, hak
  talebinden **önce** kontrol edilir; gece yarısı biten çelıncın hatırlatması yanmaz, öğlen gider;
* bitişten 48 saat sonra artık gitmez;
* beraberlikte gitmez; lafı zaten almış, hesabını silmiş ya da kazananla arasında engel olan
  kaybeden de beklemiyor sayılır. Metin yalnızca hâlâ bekleyenlerin adını sayar.

Kazananın adına otomatik laf **atılmaz**; "KOYDUM MU?" kazananın hakkı, onun ağzından başkası
konuşmaz. Kaybedenin sonuç ekranı da dürüst olur: bitişten 24 saat sonra "bekle" yerine
"unuttu galiba, rövanş aç, bu sefer sen koy" der.

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

Bunlardan ayrı, dürtmeyi kapatan (`users.nudges_enabled = 0`) hiç almaz. Bu kontrol `nudges_sent`
kaydından **önce** yapılır: kapatıp aynı öğleden sonra yeniden açan o günün dürtmesini kaçırmaz.

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

Özeti kapatan (`users.recap_enabled = 0`) satır almaz, `recaps_sent` kaydı da yazılmaz. Yeniden
açtığında sıradaki özet, atlanmış her haftada olduğu gibi son 7 güne bakar.

## Bildirim tercihleri

Android'de bütün bildirimler tek bir "koydum" kanalından geçer. Telefonun kendi ayarından susturmak
lafları da susturur, o yüzden Ayarlar → Bildirim tercihleri kimsenin istemeden aldığı üç şeyi tek
tek kapatır:

* **Geride kalınca dürt beni** → `users.nudges_enabled` (`PATCH /me { nudgesEnabled }`);
* **Pazar akşamı haftalık özet** → `users.recap_enabled` (`PATCH /me { recapEnabled }`);
* **Saatli çelınc uyarıları** → sadece o telefonda (`StorageKeys.deviceRemindersOff`), çünkü check-in
  ve son saat uyarılarını sunucu değil telefon kurar. Kapalıyken `refreshReminders` sunucuya hiç
  sormadan kurulu olanları siler; açılınca bir sonraki ön plana dönüşü beklemeden yeniden kurar.
  Ayarlar ile köprünün çağrıları sırayla çalışır, listeyi bekleyen eski bir çağrı temizlenmiş
  uyarıları geri kuramaz.

Günlük hatırlatmanın zaten kendi "kapalı" saati var. "KOYDUM MU?", kankanın elle dürtmesi, davetler,
sonuçlar ve laf sokmayı unutan kazanana giden hatırlatma kapatılamaz: uygulama bunlar için var.

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

## Bağlantı yokken

Giriş en çok çekmeyen yerde yapılır: bodrumdaki spor salonu, metro, merdiven boşluğu. Sunucuya
ulaşamayan (ya da 5xx alan) bir giriş atılmaz, `services/offlineQueue.ts` kuyruğuna girer; ilk
başarılı yazışta, uygulama açılınca, öne gelince ve arka plan görevinde sırayla gönderilir.
Sunucunun 4xx ile reddettiği giriş kesin reddir, kullanıcıya bir kez sebebiyle söylenir.

Kanıt fotoğrafı da bu yoldan gider. Bağlantı yokken seçilen fotoğraf yüklenemez; giriş ekranı onu
telefonda tutar, "Kaydet"e izin verir ve giriş fotoğrafın telefondaki yeriyle (`proofLocalUri`)
kuyruğa girer. Kuyruk önce fotoğrafı yükler ve dönen adresi girişe yazıp saklar (giriş yarıda
kalırsa fotoğraf ikinci kez yüklenmez), sonra girişi gönderir. Bu yer, fotoğraf seçicinin kendi
önbellek dosyasıdır ve telefon o önbelleği istediği an silebilir. Yüklenemeyecek bir fotoğraf
(dosya gitmiş, sunucu reddetmiş) girişten düşer ve giriş fotoğrafsız gider: fotoğraf isteğe bağlıysa
giriş sayılır, zorunluysa sunucu reddeder ve kullanıcı "Kanıt fotoğrafı telefonda bulunamadı."
diye duyar. React Native okuyamadığı dosyayı bağlantı yokmuş gibi bildirir; kuyruk ikisini
`/health`'e sorarak ayırır: sunucu cevap verdiği halde fotoğraf iki kez gitmiyorsa sorun dosyadadır.
İtiraza "Kanıt ekle" ile verilen cevabın arkasında kuyruk yok, o sadece bağlantı varken çalışır.

Ekranlar da bağlantı gidince ellerindekini bırakmaz. TanStack Query başarısız bir arka plan
yenilemesinden sonra `isError` der ama son veriyi tutar; çelınc ekranı, giriş ekranı ve odak
seansı bu durumda son bilinen hali göstermeye devam eder (ilk ikisi bunu küçük bir satırla söyler).
Hata ekranı yalnızca hiç yüklenmemiş, ya da sunucunun 404 dediği çelınc içindir.

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

İtirazla düşen (`rejected`) elle yazılmış bir gün sıfırda kalmaz: telefonun o güne okuduğu değer,
yazılandan az da olsa, yerine geçer. Değer ve kaynak telefonunki olur, durum `ok`, kanıt fotoğrafı
ve `answer_by` silinir; geri çekilmiş ya da fotoğrafla kapanmış itirazlar unutulur, haklı çıkan
(`upheld`) itirazlar `disputesWon` için yerinde kalır. Adımda 0 hiçbir şeyi geri getirmez.
Telefonun kendi okuduğu bir gün düştüyse senkron ona dokunmaz, yoksa itiraz boşa giderdi. Geri
gelen adım gününde haklı çıkmış itiraz durduğu için aynı kişi oraya bir daha itiraz edemez
(kişi başına bir itiraz); o yüzden böyle bir güne elle sayı yazmak 409 `day_rejected` alır, o
günü artık sadece telefon yazar.

Android'de adımın üç kaynağı var: Health Connect (izin verildiyse), Google Play hizmetlerinin
Recording API'si (`apps/mobile/modules/koydum-steps/`) ve uygulama açıkken sayım. Üçü yan yana
okunur, her gün için en büyüğü alınır; hepsi ancak eksik sayar, toplamak aynı adımı iki kere
sayar. Android 9'dan beri arka plandaki bir uygulama adım sensöründen hiç olay almaz; bu yüzden
uygulama kapalıyken saymanın tek yolu, sayımı Play hizmetlerinin yapması. Kayıt ilk izin anında
başlar; o günün öncesini uygulamanın ön planda saydığı değer tamamlar.

Health Connect Android 14'ten beri telefonla gelir, ama içine adım yazan bir uygulama (Samsung
Health, Google Fit) yoksa boştur ve her güne 0 der. O yüzden Health Connect'in 0'ı hiç
gönderilmez, son 7 günde adım görmeyen bir Health Connect de kaynak sayılmaz:
`getStepAvailability` o zaman telefonun kendi sayımını `hcEmpty: true` ile bildirir, ekranlar
"yaklaşık" etiketini ve "Beyan et"i ona göre gösterir. İzin düğmesi Health Connect'in izninden
sonra Fiziksel Aktivite iznini de ister; telefonun kendi sayımı bu izinle başlar.

Ekran süresinin Android tarafı `apps/mobile/modules/koydum-screen-time/` altında yerel bir Expo
modülüdür (Kotlin, `UsageStatsManager.queryEvents`). Uygulama onu adıyla arar
(`requireOptionalNativeModule('KoydumScreenTime')`), yoksa ya da izin verilmemişse sebebiyle
birlikte "okuyamıyorum" der ve ekran elle girişe döner. iPhone'da bu veri hiçbir uygulamaya
açık değildir; orada elle giriş kalıcıdır.

## Arka planda ne çalışır

`services/background.ts` on beş dakikada bir uyanan sistem görevini tanımlar. Uygulama açıkken
`NotificationBridge` bu göreve kendi işleyicisini verir; uygulama kaydırılıp kapatıldıktan sonra
görev **başsız** çalışır: JS paketi yüklenir ama React hiç kurulmaz, dolayısıyla hiçbir provider
yoktur. Bu durumda `services/backgroundWork.ts` oturumu doğrudan depodan okur ve aynı işleri
yapar: adım ve ekran süresi okumalarını gönderir, çevrimdışı kuyruğunu boşaltır, gelen kutusu
sayısını rozete yazar, telefonun kendi hatırlatmalarını da depodaki profilin seviyesi ve saat
dilimiyle yeniden kurar (zustand mağazası bu çalışmada yüklenmez). "Kimse uygulamayı açmasa da
çelınc puan toplar" sözü buna dayanır.
Sırası gelmişse işe oturumu yenileyerek başlar (aşağıda "Oturumlar"): sadece bu görevle uyanan
bir telefon da 90. gün dışarıda kalmaz.

Görevin tanımı bu yüzden `_layout`'tan değil, uygulamanın giriş dosyasından gelir:
`apps/mobile/index.ts` (`package.json`'daki `main`) önce `expo-router/entry`'yi, sonra
`services/background`'u yükler. expo-router rota dosyalarını ancak ekranı çizerken değerlendirir,
başsız çalışmada da hiçbir şey çizilmez. Tanımı bulamayan expo-task-manager görevi kayıttan
siler; yani kapalı telefona "KOYDUM MU?" ve adım gönderimi, uygulama bir daha açılana kadar
sessizce dururdu.

Görev tanımlı olsa bile Android onu pil için erteleyebilir; Xiaomi ve Samsung bunu saatlere
çıkarır. Telefonun kendi hatırlatmaları da birer alarmdır ve expo-notifications onları ancak
uygulamanın tam saatli alarm izni varsa tam saatine kurar; yoksa 06:30'da çalması gereken
check-in uyarısı 07:00'yi geçebilir. İki anahtar da sistem ayarlarında durur. Yerel modül
`apps/mobile/modules/koydum-device/` ikisinin durumunu okur ve ilgili sistem sayfasını açar;
`services/deviceHealth.ts` onu adıyla arar (`requireOptionalNativeModule('KoydumDevice')`),
iPhone'da, web'de ve Expo Go'da cevap `null` olur ve hiçbir şey gösterilmez. Ayarlar → Arka plan
ikisini de gösterir. İzin sonradan verilince önceden kurulmuş alarmlar kendiliğinden tam saatli
olmaz, o yüzden hatırlatmalar o anda yeniden kurulur. Firebase'siz bir derlemede (`no-fcm`) pil
kısıtlaması açıksa ana sayfa bunu bir kereliğine söyler: köprü her push kaydından sonra sebebi
`StorageKeys.pushReason`'a yazar, kart oradan okur.

Telefonun kendi çıkardığı bildirimler (`fireLocal`, hatırlatmalar) Android'de `koydum`
kanalına gider. Tetikleyicisi `null` olan bir bildirim kütüphanenin İngilizce "Miscellaneous"
kanalına düşer; orayı susturan biri bütün lafları da susturmuş olurdu. O yüzden hemen gösterilecek
bildirim de sadece `channelId` taşıyan bir tetikleyiciyle gönderilir. Kanalı eskiden sadece push
kaydı açıyordu; Android var olmayan bir kanala gönderilen bildirimi göstermez, o yüzden hatırlatmalar
da kurulmadan önce kanalı kendisi açar.

Check-in uyarısı eskiden her gün tekrarlayan tek bir alarmdı ve çelıncın başını sonunu bilmiyordu:
çelınc bittikten ya da iptal olduktan sonra da, uygulama bir daha açılana kadar her sabah 06:30'da
öterdi. Onu susturmak için kanalı kapatan "KOYDUM MU?" laflarını da susturmuş olurdu. Şimdi
çelıncın kalan her günü için ayrı, tarihli bir alarm kurulur (en fazla 14 gün ileriye, toplamda en
fazla 60 bildirim; iPhone en yakın 64'ünü tutup gerisini sessizce atar). Başlangıçtan önce ya da
bitişten sonra alarm yoktur, gün anahtarları da sunucunun saydığı gibi hesabın saat diliminde
sayılır. Sadece kabul edilmiş çelınclara kurulur, cevaplanmamış bir davet çalmaz. "Geldim"e
basılınca, giriş sunucuya gitse de çevrimdışı sıraya alınsa da, o günün alarmı silinir; sunucu
sıraya alınmış check-in'i kuyruk boşalınca öğrendiği için, uygulama açık kaldıkça sonraki yenilemeler
de o günü geri kurmaz. Alarmlar her ön plana dönüşte, arka plan görevinde (uygulama kapalıyken
de) ve Ayarlar'daki anahtarda baştan kurulur.

## İzinler

Köprü (`NotificationBridge`) bildirim iznini push kaydında, fiziksel aktivite iznini de ön plandaki
adım sayacını başlatırken ister. Eskiden ikisi de token gelir gelmez çalışıyordu: yeni kaydolan
birinin önüne iki sistem penceresi, karşılama ekranının ilk sayfasının üstünde, ne olduğunu
söyleyen tek kelime olmadan düşüyordu. Şimdi kayıt ekranı token'dan önce mağazadaki `onboarding`
bayrağını kaldırır ve köprü, bayrak açıkken bu iki işi başlatmaz. Karşılama ekranının dördüncü
sayfası iki izni neden istediğini söyleyip kendi düğmeleriyle sorar; "Geç" önce o sayfaya atlar.
Sayfalar nasıl kapanırsa kapansın (düğme ya da Android'in geri tuşu) bayrak iner, cevaplanmamış
izni köprü ana sayfada sorar. Bayrak saklanmaz: yarıda kapanan uygulama sonraki açılışta eskisi
gibi sorar. Köprü bir izni uygulamanın her açılışında en fazla bir kez sorar; o açılışta pencere
zaten çıktıysa (sayfadaki düğme, ana sayfadaki "İZİN VER") bir daha çıkarmaz. Yoksa sayfada
"izin verme" diyen biri ana sayfada aynı pencereyi, neden istendiğini söyleyen tek kelime olmadan,
hemen bir daha görürdü; Android'de o ikinci "hayır" da son hak demek. Bir düğmeye basmak her zaman
sorar.

Android bir izin iki kez reddedilince pencereyi bir daha göstermez; o andan sonra tek yol
telefonun ayarlarındaki KOYDUM sayfası (`openAppSettings`, yani `Linking.openSettings()`). Bildirim
izni kapalıyken telefonun kendi bildirimleri de (`fireLocal`, hatırlatmalar) sessizce düşer, yani
kullanıcı bir şey kaçırdığını fark etmez. Bu yüzden ana sayfa bunu bir kartla söyler; izin hiç
sormadan (`pushPermissionStatus`) her öne gelişte okunur, açılınca kart kendiliğinden gider.
Ayarlar → Bildirimler'de aynı düğme durur. Reddedilen adım izninin uyarısına dokunmak da aynı
sayfayı açar.

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

Kullanıcı adının tek bir yazımı var: `foldUsername` (`packages/shared/src/text.ts`) küçültür,
Türkçe harfleri ASCII'ye çevirir (ş→s, ı→i, İ→i), kalan aksanları, boşlukları ve görünmez
karakterleri atar. Kayıt, giriş ve kullanıcı adıyla arkadaşlık isteği şemada bundan geçer,
`npm run yonet -- sifre` de aynısını kullanır. Kayıt ekranı kutuya yazılanı anında çevirir, kişi
neyin kaydedileceğini görür. Eskiden "şeyma" "küçük harf olmalı" diye reddediliyordu, oysa ş da
küçük harf. `toLowerCase()` ise "İsmail"i i + U+0307 + "smail" yapıyordu, bu da hiçbir hesapla
eşleşmiyordu. 1.0 uygulaması hâlâ öyle gönderir, sunucu çevirdiği için girer.
Var olan adlar zaten ASCII, geçiş gerekmedi. Arama da sorguyu böyle çevirip kullanıcı adına bakar:
"Çağ" yazan @cagri'yi bulur. Görünen ad Türkçe harfleriyle kalır.

### Aynı sunucu, yeni adres

`npm run internet` her açılışta yeni bir trycloudflare adresi alır. JWT anahtarı
`DATA_DIR/secret`'te durduğu için eski token'lar yeni adreste de geçerlidir, ama uygulama
"aynı sunucu, yeni adres" ile "başka sunucu"yu ayıramıyordu ve her tünel yenilenişinde herkesi
çıkışa zorluyordu. Şifre gidiyordu, önbellek ve gelen kutusu imleci de; arka plan senkronu ile
bildirimler herkes şifresini yeniden yazana kadar ölü kalıyordu.

Artık `/health` bir `serverId` döner: JWT anahtarının HMAC-SHA256'sı, ilk 16 hex karakter.
Anahtar aynı kaldıkça aynıdır, eski token'lar tam da anahtar değişince ölür, yani kimlik
token'ların nerede geçtiğini birebir söyler; tek yönlü olduğu için anahtarı ele vermez.
Uygulama kimliği girişten hemen sonra ve her `/health` okumasında saklar, sadece oturum
açıkken ve hâlâ kullandığı adres için (`store/auth.ts`, `rememberServerId`).

Geçişi `services/serverMove.ts` yapar, hep bir dokunuşla (davet ekranı ya da Ayarlar →
Sunucu): önce yeni adresin `/health`'i. Saklı kimlikten farklı bir kimlik söylüyorsa başka
sunucudur ve oraya başka hiçbir şey gitmez. Kimliğin tutması ise bir şey kanıtlamaz: `/health`
herkese açıktır, davet bağlantısı da gerçek sunucuyu söyler, isteyen kimliği kopyalar. Token'ı
göndermeden önce yeni adres anahtarı bildiğini kanıtlar (`POST /auth/prove`): telefon token'ın
yalnızca `header.payload` kısmını (gizli değil) ve rastgele bir nonce gönderir; sunucu imzayı
JWT anahtarıyla yeniden hesaplar ve onu anahtar yaparak nonce ile kendi adresinin
(`publicOrigin`: PUBLIC_URL) HMAC'ini döner. Telefon aynı hesabı token'daki imzayla yapar ve
adresin taşındığı adres olduğuna bakar. Anahtarı bilmeyen bir kopya cevap veremez; soruyu gerçek
sunucuya aktaran biri de gerçek adres için bir cevap alır, telefon onu reddeder. İmza hiçbir
yöne gitmez. Hermes'te WebCrypto olmadığı için HMAC `utils/hmac.ts`'te düz TypeScript'tir
(testler node:crypto ile karşılaştırır). Sonra `/me` token'la sorulur; aynı hesap dönerse
geçilir. `/me` burada `onUnauthorized`'sız bir istemciyle gider: başka bir sunucunun 401'i
"burası değil" demektir, çıkış sebebi değil. Geçiş adresi ve kimliği yazar, bütün sorguları
tazeler, çevrimdışı kuyruğu gönderir; oturum, gelen kutusu imleci ve push kaydı yerinde kalır.
Bağlantı herkesten gelebileceği için kendiliğinden geçiş yok.

Adres ancak tünel yenilenince değiştiği için `npm run internet` (`scripts/internet.mjs`) tüneli
elinde tutar. Sunucu çökerse aynı `PUBLIC_URL` ile yeniden açar (1, 5, 15 saniye sonra; on
dakikada beşinci çöküşte bırakır). cloudflared kapanırsa (çoğu zaman ev interneti gitmiştir)
sunucuya dokunmaz, evdeki Wi-Fi ve zamanlayıcı çalışmaya devam eder; tüneli 5 saniyeden bir
dakikaya uzayan aralıklarla yeniden dener, yeni adres gelince sunucuyu onunla yeniden başlatır.
Sunucuyu durdurmak için sinyal değil IPC mesajı gönderir: Windows'ta bir alt sürece sinyal
göndermek TerminateProcess demektir, ne veritabanı kapanır ne yarım kalan iş biter. Sunucu da
kapanırken zamanlayıcının o anki turunu bekler (en çok 10 saniye): yarıda kesilen bir push
gönderimi satıra `pushed_at` yazamaz ve bir sonraki açılışta aynı KOYDUM ikinci kez gider.

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
