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
günü kendi yerel gece yarısında döner. Bu saat dilimi çelınca katılınca o çelınc için sabitlenir
(`challenge_participants.timezone`): profil sonradan değişirse (yolculuktan sonra giriş, "Cihazdan
güncelle") bu sadece yeni çelıncları etkiler, yoksa `PATCH /me` geç kalmış bir check-in'i zamanında
gösterebilirdi. Uygulama da bir çelıncın "bugün"ünü o sabit saat diliminden sayar
(`ChallengeSummary.myTimezone`, `useChallengeTimezone`): yeni saat dilimiyle saydığında Tokyo'ya
uçan birinin "Geldim"i, evet/hayır günü ve odak dakikaları sunucuya "Gelecek bir gün" olarak gidip
geri dönüyordu. Ana sayfa, gelen kutusu, sihirbaz ve haftalık özet hesabın saat dilimiyle kalır.

Sihirbaz bitişi çelıncı açanın saat diliminde gün sonuna oturtur; başka bir dilimdeki kankanın
penceresi bu yüzden bir gün uzun çıkabilir: New York'ta sabah açılan "3 gün" İstanbul'da ilk gün
16:00'dan dördüncü günün 07:59'una kadar sürer. Gün başına puanlanan türlerde (evet/hayır, ekran
süresi) o kırıntı gün bedava bir puan ya da yazılamayan bir günün 1440 dakikalık cezası demekti;
eşit oynayan biri kaybediyordu. Bu türlerde oyuncu, açanın gün sayısından fazla güne puanlanmaz
(`scoringWindow`): pencere uzunsa çelıncın daha az saatini kapsayan uç gün düşer, eşitlikte son gün.
Giriş doğrulaması, telefonların senkronu, sıralama ve uygulamanın "📅 N gün"ü, gün seçicisi ve
"Bugün"ü (`ChallengeSummary.myDays`) aynı pencereyi kullanır. Adım, odak ve sayaç gibi toplamlar her
dilimde aynı saatleri kapsar, onlara dokunulmaz; bitmiş çelınc bitişte yazılan sonucunu korur.

Check-in çelıncında günler son saatlerle sayılır (`checkinPlayableDays`): bir gün, türün açılış
saatinden son saatin son dakikasına kadarki aralığa çelınc değiyorsa oynanabilir. İstanbul'da 12:50'de
"Hemen" açılan bir günlük Erken Yatma Sözü New York'ta 15:59'da biter, oradaki 19:00 hiç gelmez; yedi
günlük olanında İstanbul, Berlin ve Londra yedi akşam oynar, New York altı. Açanın son saat sayısından
azına denk gelen kanka çelınca girmez: sihirbaz, "Kanka ekle" ve "Varım" 400 `checkin_days_short` ile
nedenini söyler (kabulde profilin saat dilimiyle, çünkü sabitlenecek olan o; "Kanka oldunuz" da böyle bir
çelıncı önermez). Fazlasına denk gelen girer ama açanın sayısı kadarına puanlanır (`scoringWindow`): daha
az kapsanan uçtaki son saat düşer, eşitlikte sonuncusu. Aynı dilimdeki oyunculara dokunulmaz. Profilini
"Varım"dan hemen önce Tokyo'ya alan biri 07:00'lik sabahları İstanbul saatiyle 00:30'da yakalar. Kabulü
saat dilimi değişti diye reddetmek gerçekten yolculuk yapanı cezalandırırdı; onun yerine herkesin oynadığı
dilim görünür (`ParticipantView.timezone`): sıralamada adının yanında "(Tokyo saati)", check-in satırında
"Tokyo saatiyle 06:30 (sende 00:30)". İtiraz eden neye itiraz ettiğini görür.

Sunucu istemcinin gönderdiği saate, tek bir istisna dışında, güvenmez:

* `clientTime` kayıt içindir, doğrulamada kullanılmaz. İstisnası sunucu yokken basılan check-in
  (aşağıda).
* Check-in'in "geç mi" olduğuna sunucu kendi saatiyle karar verir. Son saat, türün açılış
  saatinden sonra olmak zorunda (`deadlineFitsWindow`): erken yatmada 00:00 her check-in'i ya
  erken ya geç sayardı. Bu kuraldan önce yazılmış böyle bir saat türün varsayılanıyla okunur
  (`effectiveDeadline`); ekranda görünen, hatırlatmanın kurulduğu ve rövanşa geçen saat de odur.
* Check-in çelıncında her gün bir son saattir, "5 gün" beş son saat demek; ilk gün de oynanabilir
  olmalı. Sihirbazın "Yarın"ı check-in türünü ertesi gün türün açılış saatinde başlatır
  (`nextDayStartTime`): Erken Kalkan Koyar 04:00'te, Yatak Toplama Sabahı 05:00'te; açılışı 19:00
  olan Erken Yatma Sözü öteki türler gibi 09:00'da. Eskiden hepsi 09:00'da başlıyordu: Erken Kalkan
  Koyar'ın 07:00'si çelınc başlamadan geçiyor, ilk sabah kimse "Geldim" diyemiyordu ama o gün yine
  sayılıyordu, beş günlük çelıncın dört sabahı oynanıyordu. Bugünün son saati geçtikten sonra
  seçilen "Hemen" de aynı yerden başlar, sihirbaz bunu söyler ("Bugünün check-in saati geçti, ilk
  check-in yarın."); son saat geçtikten sonra açılan rövanş da öyle. Bu karar uygulamada verilir:
  sunucu eski uygulamaların gönderdiği 09:00 başlangıcını yine kabul eder. 04:00'te başlayan çelınc
  için kimse uykusundan uyandırılmaz: zamanlayıcı check-in çelıncını başlatırken oyuncunun saatiyle
  daha 07:00 olmadıysa ona "başladı" göndermez; ilk duyduğu, telefonun son saatten yarım saat önce
  çalan hatırlatması olur (`startsQuietly`). Bu ancak telefonun o hatırlatmayı kurabildiği yerde
  geçerli: telefon onu iki kişinin kabul ettiği çelınca kurar, başlangıçtan önceki bir saate de
  kurmaz. İkinci "varım" başlangıçtan sonra geldiyse (Veli 05:45'te kabul etti, zamanlayıcı 30 sn
  içinde başlattı; Ali'nin telefonu tek başına beklediği çelıncı listeden atmıştı) ya da ilk son saat
  başlangıçtan yarım saatten az sonraysa (04:20), "başladı" saat kaç olursa olsun gider: yoksa ilk
  sabah oyunculardan biri hiçbir şey duymadan kaybederdi. "Hemen" çelıncını iki kişi yapan kabulün
  "başladı"sı da saate bakmaz.
* Sunucunun duyamadığı zamanlar da olur: bilgisayar uyur, kapanır, pencere kapanır. Zamanlayıcı
  bunları `server_pauses`'a yazar: iki vuruşu arasında beş dakikadan uzun bir boşluk, ya da açılırken
  kapanmadan önceki son vuruşundan (`server_state`; düzgün kapanış onu kapanış anında yazar) bu yana
  geçen süre, ne kadar kısa olursa olsun: `dur` ile `y` arasındaki üç dakikada tünel 502 döner,
  o arada basılan "Geldim" de gecenin uykusundaki gibi sayılmalı. 014'ten eski bir sürüm bu vuruşu
  hiç yazmıyordu; ondan güncellenen veritabanına migration 017 onun yerine eski sunucunun en son
  duyduğu anı koyar (en yeni `last_seen_at`, kayıt ya da bildirim saati). Yoksa yeni sürümün ilk
  açılışı kesinti yazmaz, güncelleme sırasında basılan "Geldim" geç kalmış bir 0 sayılır, sunucu
  gece kapalı kalıp sabah güncellendiyse "sadece bugün" diye reddedilirdi. Çalışırken saat de ileri alınabilir
  (Linux'tan sonra üç saat geride açılan Windows `w32tm /resync` ile düzelir): duvar saatine göre
  bu da iki vuruş arası üç saatlik bir boşluk gibi görünür, ama sunucu o arada açıktı. Boşluk bu yüzden
  makinenin açık kalma süresiyle de ölçülür (`os.uptime`: uykuda da sayar, saat ayarıyla oynamaz);
  onun görmediği bir boşluk kesinti yazılmaz, pencerede "bilgisayarın saati 3 saat ileri alındı"
  yazar. O arada telefonun sıraya
  aldığı check-in sunucuya ancak sonra varır. Vardığı an günü ya da son saati kaçırıyorsa ve
  `clientTime` son 12 saatte biten böyle bir aralığın içindeyse, check-in basıldığı ana göre
  değerlendirilir (`checkinInstant`): son saat 23:30, bilgisayar 23:00-08:00 uyumuş, 23:10'da basılıp
  08:30'da gelen "Geldim" o gecenin ve zamanında sayılır. Günün yaşı da o ana göredir (kapağı hafta
  sonu kapalı kalan bilgisayarda cuma gecesinin check-in'i pazartesi "2 günden eski" olmaz), satırın
  kayıt saati de odur: telefonlar "bugün yaptı mı"yı en son kaydın saatinden okur, sabahki varış
  saatiyle yazılan dünkü check-in o akşamın hatırlatmasını susturuyordu. Tek istisna çelıncın son
  gecesi: süre bittikten sonra gelen check-in, uykuda basılmış olsa da reddedilir (sonuç o arada
  belli olur). Sunucunun zaten yazdığı bir check-in'in tekrarı (cevabı kaybolmuş, kuyruk sabah yine
  gönderiyor) "sadece bugün" diye değil "O gün zaten check-in yapmıştın." diye cevaplanır; bu kontrol
  çelıncın durumundan ve bitişten de önce çalışır, son gecenin tekrarı çelınc bittikten sonra gelse de
  böyle cevaplanır. Kuyruk onu gitmiş sayar. 22:00 yazan bir check-in'e güvenilmez,
  sunucu o saatte ayaktaydı ve basılsaydı duyardı. Bedeli: kayıtlı bir kesintinin içinde saatini
  geri almış bir telefon o aralığın herhangi bir dakikasını iddia edebilir; dışında hiçbir şey
  kazanmaz.
* Telefonların kuyruğu bekleyenleri tünel yeniden cevap verdiği an gönderir, bu da çoğu zaman
  zamanlayıcının uyanıştan sonraki ilk vuruşundan öncedir. 23:10'da basılıp 08:05'te ilk gelen
  "Geldim" henüz yazılmamış bir uykuya çarpıp "sadece bugün" diye reddediliyor, uykuda başlaması
  gereken çelınc "aktif değil" diyor, uykuda biten bir adım çelıncında itiraz "Süre bitti"
  alıyordu. Bu yüzden son vuruştan beş dakikadan uzun süre sonra gelen istek o vuruşu önce kendisi
  çalıştırır (`app.ts`'teki `onRequest` kancası `catchUp`'ı çağırır): kesinti yazılır, `bootAt`
  taşınır, tur döner, istek ondan sonra cevaplanır. Vuruşlar arasında bu tek bir çıkarmadır;
  istekle zamanlayıcıdan hangisi ikinci gelirse boşluk bulmaz, süren bir turun üstüne ikincisi de
  başlamaz. Uykudan önceki tur bir push gönderiminde asılı kaldıysa uyanışın vuruşu tur başlatmaz;
  "Yarın 04:00" çelıncına gelen "Geldim" yine "aktif değil" almasın diye giriş rotası da başlama
  vakti gelmiş çelıncları başlatır (`activateDueChallenges`). İptal, liste ve detay okuması da aynısını
  yapar: ekran geri sayımı bittiği anda detayı yeniden ister, vuruş 30 saniye sonra gelebilir; o
  arada dönen `pending` uygulamaya "sunucuya ulaşamadım" dedirtiyordu.
* Açılıştan ya da uyanıştan (`bootAt`) sonraki ilk 20 dakika (`WAKE_GRACE_MS`) zamanlayıcı günlük
  hatırlatmayı ve gün ortası dürtmeyi göndermez. Telefonlar bekleyenleri ancak bir sonraki
  gidişlerinde gönderir: açık uygulama hemen, cepteki telefon arka plan görevinin bir sonraki
  turunda, en erken 15 dakikada bir. Bilgisayar 10:00-13:00 uyuduğunda uyanışın ilk turu 10:30'da
  işaretleyen Veli'ye "Bugün hâlâ sıfırdasın" ve "Ali sana 1 gün fark koymuş" gönderiyor, girişi bir
  dakika sonra geliyordu; günün tek dürtmesi de olmayan bir farka harcanıyordu. İkisi de her şeye
  hak satırından (`reminders_sent`, `nudges_sent`) önce bakar, bu arada hiçbir hak yazılmaz: aradan
  sonraki ilk tur bekleyenler sayılmış haliyle gönderir, hak satırları da ikincisine izin vermez.
  Telefonu 20 dakikadan geç gelen yine hatırlatma alabilir.
* Sunucu çelınc bittikten sonra odak dakikası almaz. Odak ekranı seansı kalan süreye sığdırır,
  molalarla uzayan seansı da bitişe 30 saniye kala kapatıp tam dakikalarını gönderir.
* Geçmiş güne giriş penceresi (manuel 2 gün, adım 7 gün) sunucunun "şimdi"sine göredir.

Sunucudaki tek "şimdi" kaynağı `app.now()`'dur. Testler oraya kontrollü bir saat enjekte eder,
bu yüzden çelınc yaşam döngüsü gerçek zamana hiç bağlı değildir.

Uygulama da sunucunun saatine bakar. Her `/health` cevabı o saati (`time`) taşır; telefon onu
isteğin gidiş-dönüşünün ortasında okunmuş sayar ve aradaki farkı tutar (`utils/serverClock.ts`;
5 saniye ve üstü süren bir cevap bir şey söylemez, sayılmaz). Sihirbazın "Hemen"i ve
"Yarın"ı bu farkla, yani sunucunun saatiyle kurulur: sunucu beş dakikadan eski bir başlangıcı
reddettiği için 20 dakika geri kalan bir telefon eskiden hiç "Hemen" çelınc açamazdı. Bu tahmin
gidiş-dönüşün yarısı kadar şaşabilir: sunucunun saatini bir an ileri tahmin eden "Hemen" ileri
tarihli sayılıp bir kanka "Varım" diyene kadar `pending` beklemesin diye sunucu bir dakikadan az
ilerideki başlangıcı "şimdi" sayar ve öyle kaydeder. Bu düzeltmeden önceki uygulamalar telefonun
saatini gönderir; onlar artık genel "Gönderdiğin bilgiler geçersiz." yerine `start_in_past`
hatasının nedenini söyleyen mesajını görür. Fark 3 dakikayı geçince ana sayfada ve Ayarlar'da hangi
saatin ne kadar ileri ya da geri olduğunu söyleyen bir kart çıkar. Fark sunucuya aittir: çıkış
yapınca ya da başka bir adrese geçince unutulur (`forgetServerTime`), yeni adresin ilk `/health`'i
yeniden ölçer. Yanlış olan çoğu zaman
bilgisayardır: Linux'la yan yana kurulu bir Windows, Linux'tan sonra donanım saatini yerel saat
sanıp 3 saat geri başlar ve eşitlenene kadar öyle kalır. O arada check-in'ler yanlış saate göre
değerlendirilir, çelınclar saatlerce kayık biter; kart bilgisayarın saatini nasıl eşitleyeceğini
anlatır.

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
kişi yapabilecekse bekler. Reddeden onu çağırana (sonradan "Kanka ekle" ile çağrılmadıysa açana),
ayrılan içeride kalanlara haber verir ("Ali tırstı, reddetti", "Ali havlu attı"), engelli ikiliye
hiçbir şey gitmez. Bitişten sonra ikisi de sessizdir ve iptal etmez: o bekleyişte sonuç
zamanlayıcınındır, kaybeden kimse ayrılıp sonucu bozamaz.
Reddetmek de son söz değildir: çelınc sürdükçe reddeden kabul edebilir, uygulama bunu çelınc
ekranında "Katıl" diye sunar. Oynayıp ayrılan geri giremez (`already_left`): herkese "havlu attı"
dendi, itiraz çoğunluğu da ona göre küçüldü. Davetlinin "Ayrıl"ı ise bir rettir, sunucu da onu öyle
yazar (`declined`). Eski uygulamalar davetliye "Varım" ve "Yokum"un yanında "Ayrıl" da gösteriyordu;
`left` yazılınca davetli ne "Katıl" görüyordu ne de "Kanka ekle" ile yeniden çağrılabiliyordu,
oysa sunucu onu geri alırdı. Uygulama "Ayrıl"ı artık yalnızca kabul etmiş oyuncuya gösterir.
Sessiz bir davetli yüzünden bitişe kadar açık kalıp tek kişiyle biten çelınc da zamanlayıcıda
"herkes kaçtı" diye kapanır, kabul edip giden biri varsa "kimse kabul etmedi" yazmaz.

Kabul de sessiz değildir. "Hemen" başlayan çelınc oluştuğu anda `active` olur ve içinde sadece
açan vardır; zamanlayıcı yalnızca `pending` çelıncları başlattığı için böyle bir çelıncta
"başladı" hiç denmiyordu. Onu iki kişi yapan ilk kabul (daha önce kimse katılmadıysa) ikisine
`challenge_started` gönderir. Başlangıç saati geçmiş bir `pending` çelıncı iki kişi yapan kabul
hiçbir şey göndermez: zamanlayıcı onu 30 saniye içinde başlatır ve aynısını söyler. Diğer her
kabul `challenge_accepted` olur ("Ali kabul etti"): başlamamış çelıncta açana ve onu çağıran başka
biriyse ona da, süren çelıncta içerideki herkese; ret ve ayrılmayla aynı yoldan (`tellWhoIsIn`),
engelli ikiliye ve silinmiş hesaba gitmez. Kimse katılmadan süren bir çelıncta uygulama "öndesin" demez, "Rakip bekleniyor"
der.

Çelınc sürerken oyuncular kanka da ekleyebilir (`POST /challenges/:id/invite`): uygulamayı herkes
aynı gün kurmuyor, ikinci gün gelen kanka için açılan ikinci bir çelınc grubu böler. Eskiden bunu
yalnızca açan yapabiliyordu, ama yeni gelen çoğu zaman bağlantıyı dağıtanın kankası olur, açanın
değil: grup çelıncını başka biri açmışsa yeni geleni ne açan (kankası değil) ne de bağlantıyı
dağıtan (açan değil) ekleyebiliyordu, üç kişi WhatsApp'ta çözüyordu. Artık kabul etmiş her oyuncu
kendi kankasını çağırır. Eklenen, sihirbazda seçilmiş gibi `invited` girer ve aynı kapıdan kabul
eder; satır kimin çağırdığını tutar (`invited_by`, boşsa açan): ret ona gider, ana sayfadaki davet
kartı da onun adını yazar. İptal yine yalnızca açanındır. Kapı da ikisi için aynı anda
kapanır (`acceptClosesAt`: bitişten bir saat önce, kısa çelıncta sürenin son dörtte biri); kabul
edilemeyecek bir davet boş bir bildirimdir. Sunucu bu anı her çelıncla gönderir
(`Challenge.acceptClosesAt`) ve uygulama kapıyı kuralın kendi kopyasına değil, ona bakarak kapatır:
ana sayfa, kapısı kapanmış daveti "Davetler"de göstermez; çelınc ekranı "Varım" ve "Katıl" yerine
"Bu çelınca katılım kapandı." der. Eskiden ikisi de her dokunuşta yalnızca hata veren bir düğme
sunuyordu. Kapı açıkken davetli, "Varım"ın hemen üstünde kuralları görür (kim kazanır, kaç gün, hangi
saate kadar, elle girilen sayıya fotoğraf gerekir mi, girilmeyen gün kaç sayılır, ödül ve ceza):
arkadaşlar kör kabul edip sonra kaçıyordu. Biten çelıncta cevaplanmamış bir davet artık "DAVET" ya da
"bekliyor" diye görünmez: kart "KAÇIRDIN" der, final tablosu onu hiç göstermez. Bitişten sonraki
bekleyişte kimse eklenmez. Reddeden yeniden çağrılabilir ve yeni bir davet bildirimi alır; oynayıp
ayrılan çağrılamaz, kabul kuralıyla aynı sebepten. Çelınctaki biriyle (kabul etmiş ya da davetli)
arasında engel olan da çağrılamaz (`blocked_in_challenge`): sihirbazda herkes kimlerle oynayacağını
kabul etmeden görüyordu, sonradan gelen davette kimse bir şey kabul etmedi, ve akış engelleyenin her
sayısını, fotoğrafını engellenene gösterirdi. Ret kimin kimi engellediğini söylemez. Davetten
sonra konan engel de kazanır: çağrılanla çelıncı açan ya da onu çağıran arasında engel varsa kabul
edemez (403 `blocked`). Kabul etmiş başka bir oyuncuyla arasında engel varsa da edemez (400
`blocked_in_challenge`, "Bu çelınca katılamazsın.", kimseyi söylemez): sonradan çağrılan çoğu zaman
öbür oyuncuların tanımadığı biridir, ona hayır demenin tek yolu engeldir; reddedip sonra fikrini
değiştiren de o arada gelmiş engellisinin yanına oturamaz. Engelli iki kişi, hangisi ikinci kabul
ederse etsin, aynı çelıncta asla birlikte `accepted` olmaz. Çelıncı açan çıkıp gitmiş olsa da
sayılır: onun engellediği biri çağrılmaz, "kanka oldunuz" haberi de onu o çelınca yönlendirmez
(`invitableFor`), çünkü kabul kuralı açanla arasındaki engele hep bakar. Çelınc sürerken konan
engel ise kimseyi çıkarmaz (`upsertBlock` katılımcı satırlarına dokunmaz), bu yüzden iki oyuncu da
içerideyken itiraz kapısı açık kalır: kapansaydı elle 99.000 yazıp rakibini engelleyen,
sorgulanamayan bir sayıyla kazanırdı. Girişin sahibine giden bildirim o zaman itiraz edenin adını
yazmaz ("Bir rakibin"); diğer oyuncuları çağıran bildirim ve itiraz edene giden kanıt ve karar
haberleri engelli ikiliyi yine atlar. Çelınctan çıkmış biriyle aradaki engel kapıyı kapalı tutar
(403 `blocked`). Sunucunun kendi bildirimleri de engelli ikiliye birbirinin adını söylemez ama
gitmeye devam eder: gün ortası dürtme ("Bir rakibin…", aşağıda), bitiş haberi (kaybedene
"Kazanan Ali" yerine yalnız kendi skoru; beraberliğin arkasında kalana, birincilerden biriyle
engeli varsa hiçbir isim, "Birinciler berabere kaldı") ve çelıncı açanın başlamadan iptali
(yalnız çelıncın adı, kimin iptal ettiği yok).

Rövanş, eskisi kaç yerel gün sürdüyse o kadar gün sürer ve sihirbaz gibi açanın saat diliminde bir
günün son milisaniyesinde biter. Önceden "şimdi + eski süre" ile düğmeye basılan saatte bitiyordu;
yarıda kesilen son günün sonradan gelen telefon sayısı bitişten sonra atılan adımları da taşırdı.
Beş dakika sonra başlar; check-in çelıncında o beş dakikanın sonunda açanın saatiyle bugünün son
saati geçmiş oluyorsa ertesi gün sihirbazın "Yarın"ı gibi başlar (`nextDayStartTime`, yukarıda:
Erken Kalkan Koyar 04:00'te, Erken Yatma Sözü 09:00'da): akşam 22:00'de açılan Erken Kalkan Koyar
rövanşı 22:05'te başlasaydı ilk günü kimsenin oynayamadığı bir gün olurdu.
Reddedilen (yani iptal olan) bir rövanş yenisini açmaya engel değildir.

Bir çelıncın rövanşı bir tane olur. Rövanş düğmesi iki tarafta da kocaman durur; ikisi de basınca
aynı kankalar iki kere davet ediliyor, grup birbirinin aynısı iki çelınca bölünüyordu. Artık başkasının
açtığı ve içinde olduğun (kabul etmiş ya da davetli) bir rövanş varken yenisi açılmaz
(`rematch_exists`, "Ali rövanşı zaten açtı, davet sende."). Sonuç ekranı bunu baştan bilir
(`rematch`): düğme o rövanşa gider ("Rövanş daveti sende", "Rövanşa git", bittiyse "Rövanşın
sonucu"). İptal olan, reddettiğin, ayrıldığın ya da hiç çağrılmadığın (açanın kankası değilsin) bir
rövanş sayılmaz, kendi rövanşını açabilirsin. Kendi açıp sonra içinden çıktığın da öyle: aynı
kişiye ikinci rövanşı engelleyen `already_rematched` da yalnız hâlâ içinde olduğun rövanşı sayar,
yoksa düğme her basışta "zaten rövanş açtın" deyip dururdu. Artık kabul edemeyeceğin bir davet de sayılmaz, kabul
kapısının kendi kuralıyla: kapısı kapanmış (`acceptClosesAt`) ya da sen cevap vermeden bitmiş bir
rövanş (onu oynamadığın için sonucundan da rövanş açamazsın), ya da açanla arana sonradan engel
girmiş bir davet. Yoksa düğme kapalı bir kapıya götürür, kendi rövanşını açmana da izin vermezdi.
Davet edilecek kimse kalmadıysa (`rematchInvitable` 0) düğme sönük durur; önceden basınca 400
`no_participants` dönüyordu.

Adımı ya da ekran süresini telefonun kendisinin saydığı çelınclar bitişte hemen kapanmaz. Son
akşamın adımları telefonda bir sonraki arka plan senkronunu bekler (15 dakika ve üstü), gece
yarısı kapatırsak kazananı eksik sayıyla seçeriz ve sonradan gelen adımlar çöpe gider. Bu yüzden
çelınc bir saat daha `active` kalır: telefonlar son günü `POST /me/steps` ve `/me/screen-time` ile
göndermeye devam eder, `POST /challenges/:id/entries` ise bitişten itibaren hiçbir şey almaz
(`challenge_ended`). Elle yazılan sayı da, elle hazırlanmış bir istekte "telefon okudu" diye
(`pedometer`, `usage_stats`) gelen sayı da sonucu gördükten sonra seçilmiş olabilir. Herkesin
telefonu son günü bitişten sonra gönderdiyse ve bitişten sonra hiçbir girişin sayısı değişmediyse
beklemeden kapanır (`movedAfterEnd`). Değiştiyse saatin sonu beklenir: o saat son akşamın sayılarına
itiraz edilsin diye var. Eskiden "herkes gönderdi" saati kısa kesiyordu; telefonunu rakibinin gece
yarısından sonraki senkronuna kadar kapalı tutan biri sonra üç günü birden yükseltiyor, bir sonraki tur
onu kazanan ilan ediyor, rakibin itirazı "aktif değil" diye dönüyordu. Senkron yalnız sayısını
değiştirdiği satırın `updated_at`'ini oynatır, yeni bir şey getirmeyen senkron erken kapanışı bozmaz.
iPhone adımları arka planda pek göndermez, bu saat çoğu zaman ancak uygulama açılırsa işe yarar; o
yüzden telefon adım çelıncının
bitişinden iki dakika sonra kendi bildirimini kurar (`services/reminders.ts`). Ona dokunmak
çelıncı açar, uygulama öne gelirken ve "Sonuç birazdan" ekranında son günü gönderir; son saat
uyarısı da "Skorunu girmediysen" yerine bunu söyler. Sunucu bitişte kapalıysa bir
saat açıldığı andan sayılır (`bootAt`). Bitişte uyuyan bilgisayar da kapalı sayılır: Windows
uyanınca süreç yeniden başlamaz, ama zamanlayıcının iki vuruşu arasında beş dakikadan uzun bir
boşluk görülünce `bootAt` uyandığı ana taşınır (`nextBootAt`). Elle girilen çelınclar tam bitişte
kapanır; ama son bir saatinde telefonun yazmadığı bir giriş eklendiyse ya da değiştiyse
(`lateTypedEntry`; bitişten sonra bir itiraza gelen fotoğraf sayılmaz, o kapanmış itirazları
yeniden açardı) onlar da aynı saati bekler, itiraz da o saatte açık kalır. Elle yazılan sayının tek
denetimi itirazdır: bitişe 30 saniye kala gönderilen altı tane 180 dakikalık odak seansı ya da 300
sayfa, rakibine itiraz için 30 saniye bırakıyordu. Bu bekleyiş de bir saati geçmez (sunucu bitişte
kapalıysa `bootAt`'ten bir saat); o saatte açılan bir itiraz sonucu ancak kendi 12 saatiyle tutar.
Adım çelıncında "Beyan et" ile bitişte yazılan bir gün de böyle saati sonuna kadar işletir, herkesin
telefonu gönderse bile. Bitişten sonra senkron yalnızca bitişte bitmiş günleri değiştirebilir
(`dayOverByEnd`): bitiş bir günü yarıda kestiyse (başka saat dilimindeki bir oyuncu, eski usul 24 saatlik bir
çelınc) o günün sonraki okuması bitişten sonra atılan adımları da taşır, o yüzden gün bitişteki
haliyle kalır ve o oyuncu beklenmez. Bekleyişte dürtme de yoktur: "hâlâ açık, sıra sende" yalan
olurdu.

İtiraz tek başına bir girişi silmez. Diğer oyuncuların çoğunluğu itiraz edince girişin sahibine
12 saat (`LIMITS.DISPUTE_ANSWER_MS`) tanınır ve giriş bu sürede sayılmaya devam eder; yoksa teke tek
çelıncta kaybeden taraf rakibinin her gününü tek dokunuşla sıfırlayabilirdi. Sahibi fotoğraf eklerse
itirazlar `dismissed` olur. Girişin sayısı sonradan değişirse (elle ya da telefonun senkronuyla) bu
itirazlar unutulur (`forgetDismissedDisputes`), kanka yeni sayıya yine itiraz edebilir: fotoğraf
eski sayıyı destekliyordu, teke tekte de yeni sayıya itiraz edebilecek tek kişi rakiptir. Eklemezse zamanlayıcının `resolveDisputes` adımı (bitirmeden hemen önce
çalışır) girişi `rejected` yapar ve itiraz edenlerin `disputesWon` sayısı artar. Haberi iki taraf da
alır: sahibine `entry_rejected`, itiraz edenlere `dispute` (`kind: 'upheld'`); fotoğrafla kapanan
itirazda olduğu gibi, işi başlatan da nasıl bittiğini duyar (sahibiyle arasında engel olan ya da
hesabını silen hariç). Bildirimler günü "21 Ekim Salı" diye yazar (paylaşılan `formatDayKeyTr`), "2026-10-21
tarihli" diye değil; ay adları Hermes'e güvenmeden tablodan gelir. Dört kişiden itibaren
tek itiraz çoğunluk etmez. Eskiden onu yalnız girişin sahibi duyuyordu, on kişilik bir kitap
çelıncında gereken beş itiraz hiç toplanmıyor, yazılan 600 sayfa sayılıp kazanıyordu. Artık bir
girişe ilk itiraz gelince diğer oyuncular da kendi seviyelerinde `dispute` alır (`kind: 'call'`):
sahibi ve itiraz eden kendi bildirimini zaten alıyor, ikisinden biriyle arasında engel olan ya da
hesabını silen hiç almaz. Bu, girişin `disputes`'taki ilk satırında bir kere olur; geri çekilen bir
itirazın ardından başka bir kankanın açtığı itiraz herkesi yeniden rahatsız etmez. Akış da
çoğunluğa kaç itiraz kaldığını gösterir (`FeedItem.disputeVotes`, "İtiraz 1/5"). Süre çoğunluğun
oluştuğu andan başlar, ilk itirazdan değil, ve girişin üstüne yazılır (`entries.answer_by`,
`syncDisputeClocks`). Her geçişte oyuncu sayısından yeniden hesaplanınca biri ayrılıp çoğunluk
küçüldüğünde eski bir itirazın süresi saatler önce dolmuş sayılıyor, giriş haber verilmeden
atılıyordu. Artık ayrılma, hesap silme ve zamanlayıcının her turu saati o andan tam 12 saatle
kurar ve sahibine söyler; `answer_by`'ı olmayan eski bir veritabanında da ilk tur böyle yapar.
Sunucu kapalıyken ya da uyurken dolan bir süreye, sunucu dönünce bir saat daha eklenir
(`bootAt + DEVICE_SETTLE_MS`, yine `answer_by`'a yazılır): sahibinin son saatlerde gönderdiği
fotoğraf uyuyan sunucuya hiç ulaşmadı. Saatin başladığı an ayrıca durur (`answer_from`), yoksa
uzayan süreyle birlikte kayar ve arada katılan bir kankayı içeride sayardı.
Ayrılan birinin itirazı sayılmaz, girişi de: girişine açılan itiraz kaydedilir ama kimseye haber
vermez (bıraktığı bir çelınc için "Kanıtını göster" gürültüden ibaret), uygulama da o satırda
itiraz düğmesi göstermez. İtiraz açmak ve kendi girişini silmek yalnız `accepted` oyuncunun işidir;
daveti bekleyen ya da ayrılmış okuyucu akışı görür ama iki düğme de ona çıkmaz (sunucu "Bu çelınca
katılmadın." derdi). İtirazını geri çekmek ve kanıt eklemek ayrılana da açık kalır. İşleyen bir
saat, başladığı anda içeride olan oyunculara göre
ölçülür (`joined_at`): sonradan çağrılan bir kanka (**Kanka ekle**) oy vermedi, çoğunluğu
büyütüp saati durduramaz; yoksa itiraz edilen kurucu iki kanka ekleyip itirazı sessizce
boşa çıkarabilirdi. Eski uygulamada "Kanıt ekle" yoktur: günü fotoğrafla yeniden
göndermek de itirazı cevaplar. Fotoğrafla kapanan ya da geri çekilen itirazın sahibi, giriş
sayısını ya da fotoğrafını değiştirince yeniden itiraz edebilir. Bitişte süresi dolmamış bir itiraz
varsa çelınc o süre boyunca `active` kalır; yoksa son dakika gelen bir itiraz, sahibine söz verilen
12 saati yerdi. Bu bekleyişte yeni itiraz alınmaz (adım ve ekran süresi çelınclarının bir saati
hariç, son akşamın sayıları o saatte gelir; son saatinde elle sayı girilen bir çelıncın bir saati de
öyle; `disputesCloseAt`), yoksa art arda açılan itirazlar sonucu günlerce bekletebilirdi. Bitişten sonra ayrılmak da kapalıdır: teke tek çelıncta kaybeden
ayrılıp sonucu iptal ettirebilirdi.

İtiraz çelınc boyunca açıktır ama itiraz düğmesi yalnız akışın satırlarındadır, akış da en yeni
40 girişi (artı itiraz bekleyen her girişi) taşır. Dört kişilik 14 günlük bir adım çelıncı 56 satır
yazar, on kişilik bir odak haftası salıyı perşembeye gömer: ilk günler itiraz edilemez kalıyordu.
"Daha eski girişler" onları `GET /challenges/:id/feed` ile sayfa sayfa getirir. Sayfalar
(`created_at`, `id`) çiftiyle kesilir, akışın kendi sırasıyla: bir telefon senkronu birkaç günü aynı
milisaniyede yazar, yalnız ana göre kesmek o satırları atlar ya da tekrarlar. Ayrıntı ekranı nerede
durduğunu kendisi söyleyemez (sonunda eski bir itirazlı satır durabilir), o yüzden sunucu
`feedCursor`'ı verir. Uygulama ise sayfaları o imleçten değil en yeniden başlatır (ilk sayfa 80
satır), ayrıntının 40'ını tekrar indirmek pahasına: ayrıntı kendi başına 45 saniyede bir yenilenir
ve her yeni giriş en eskisini 40'ın dışına iter. Eski bir imleçten başlayan sayfalar o satırı bir
daha göstermezdi; en yeniden kesintisiz gelen bir dizide arada kaybolacak yer yoktur. Ayrıntının
imlecine kadarki satırlar ise yalnız ayrıntıdan gelir: sayfalar kendiliğinden yenilenmez, arada
silinen bir giriş eski sayfadan geri gelip itiraz düğmesiyle 404 vermesin.

## Puanlama

`packages/shared/src/scoring.ts` saf bir fonksiyondur: girdi olarak çelınc tipi, gün listesi ve
girişler alır, sıralamayı döndürür. Veritabanına, tarihe veya ağa dokunmaz. Sunucu her yazma
sonrası bunu bellekte yeniden çalıştırır; kaydedilmiş bir "skor" alanı yoktur, sadece çelınc
kapanırken sonuç `challenge_participants.final_score` alanına yazılır.

Altı metrik türü vardır ve hepsi aynı arayüze oturur: `auto_steps`, `focus_minutes`,
`checkin_deadline`, `daily_boolean`, `manual_count`, `manual_lower_is_better`. Yeni bir çelınc
türü eklemek katalogda bir satır demektir — sunucu ve uygulama kodu değişmez. Evet/hayır
türünde soruyu ve iki düğmenin adını da (`askTr`, `yesTr`, `noTr`) katalog verir; `yesTr` her
zaman sayılan gündür, "İçmedim" gibi.

İki istisna bilinsin. `manual_lower_is_better` (ekran süresi) toplam değil **günlük ortalama**
ile yarışır: girilmeyen gün en kötü değerden sayılır, toplam pencere gün sayısına bölünür. Böylece
saat dilimi yüzünden penceresi bir gün kısa kalan oyuncu cezalandırılmaz (bir gün uzun olanınki
açanın gün sayısına kırpılır, yukarıda) ve katalogdaki "ortalaması en düşük olan kazanır" cümlesi
doğru olur. Çelınc sürerken pencere bitmiş günlere kırpılır; ikinci
günde beş günlük "girilmedi" cezası gösterilmez. Bugün, girişleriyle birlikte, ortalamaya ancak
yarın girer: Android telefon öğlen yarım günü gönderir (şimdiye kadar 40 dk), iPhone'cu ekran
süresini gece yazar; yarım gün ortalamaya girse iPhone'cu bütün öğleden sonra geride görünür ve
"sana fark koymuş" dürtmesi yer. İlk gün öncesinde gün olmadığı için bugün kalır: hiçbir şey
girmeyen 0 ile öne geçmez, bugünün cezasıyla (1440 dk) görünür. `ends_at` gelince tam pencere
uygulanır; gün ortasında biten bir çelıncta girilmeyen son gün de sayılır, çünkü artık
yazılamaz. Sonradan gelen, yazmaya başlayabildiği günün bir gün öncesinden
(`LIMITS.MANUAL_PICKER_DAYS`) puanlanır. O an, davetin geldiği an (`invited_at`: sihirbazın ve
rövanşın davetlileri için çelıncın açıldığı an, "Kanka ekle" ile gelen için o davetin anı) ile
çelıncın oynanabilir olduğu andan hangisi sonraysa odur; ileri bir saate kurulan çelınc, kuranın
yanına biri "Varım" diyene kadar `pending` kalır ve kimse, kuran da, giriş yazamaz. Daveti bekletip sonra
"Varım" diyen geç gelmiş sayılmaz: sıralamayı izleyip kötü günlerini atmasın diye beklediği
günlerin cezasını öder. Ekran süresinde giriş ekranı iki gün geriye yazdırır; gece "Varım" diyen
de o ilk günü ertesi gün boyunca yazabilir. Daha önceki günlere ceza kesmek çelıncı baştan
başkasına vermek olurdu. O günlerin girişleri de (Android telefon bir hafta geriye senkronlar)
toplama girmez; ortalama her girişi pencerenin gün sayısına böldüğü için kalsalar ortalamayı
bozarlardı. İkincisi: `manual_count` ve `focus_minutes` girişleri
bir `sessionId` taşır ve aynı kimlikle gelen ikinci istek yeni bir satır değil, ilk satırın kendisidir. Telefon her dokunuşta
yeni bir kimlik üretir; zaman aşımına uğrayıp çevrimdışı kuyruğundan tekrar gönderilen istek
böylece bir bardak suyu iki kez saymaz. Tekrar, çelıncın durumuna bakılmadan cevaplanır: son
dakikalarda yazılıp cevabı kaybolan seans zamanlayıcı çelıncı bitirdikten sonra gelirse "aktif değil"
diye reddedilmiş görünmez, yazılan satır döner.

Odak günü kataloğun dediği gibi 360 dakikada kesilir (`maxPerDay`, itirazla düşen seanslar
sayılmaz). Kalanı aşan seans reddedilmez, kalana kırpılarak yazılır: eski APK seansın tamamını
gönderir, reddetmek sığan kısmı da çöpe atardı. Tekrar gönderilen bir seans bu hesaba hiç gelmez,
`sessionId` kontrolü önce çalışır. Bir dakika bile kalmadıysa 400 `daily_cap`. Odak ekranı da
seansı günün kalanına göre kısaltır ve "Bugün 30 dk hakkın kaldı" der; kaydedince sunucunun
yazdığı sayıyı gösterir. Eski APK'nın odak ekranı ise sunucu ne yazarsa yazsın seansın tamamını
"skoruna eklendi" der; kırpılan her seans için yazana bir bildirim gider ("“Odak Ligi”: 180
dakikalık seansın 60 dakikası yazıldı. Günde en fazla 360 dakika sayılıyor."). 360 dolduktan sonra
eski APK seansı yine de başlatır, bitince sunucu reddeder.

Adım, tekrar, kat, sayfa ve dakika türlerinde (katalogda `wholeNumbers`) küsurat yoktur: sunucu
12,43 adımı 400 `not_whole` ile geri çevirir. Uygulama binlikleri noktayla yazar (12.430), kanka da
öyle yazınca eski giriş ekranı noktayı ondalık sanıp 12,43 adım gönderiyordu ve 9.000 adımlık rakip
kazanıyordu. Giriş ekranı bu türlerde artık "12.430"u da "12,430"u da binlik okur
(`parseTypedNumber`), "12,5"i ise göndermeden "Küsurat olmaz, tam sayı yaz." der. Km, bardak ve
porsiyonda yarım birim bir şey demektir, orada virgül ondalık kalır. Güncellemeden önce sıraya
alınmış bir 12,43 adım sunucuya gidince çevrimdışı kuyruğunun reddi olarak kankaya döner ("“Adım
savaşı” · Dün: Küsurat olmaz, tam sayı yaz."); sessizce yanlış kazanan seçilmez.

## Laf sokma zinciri

1. Çelınc biter, `winner_id` yazılır.
2. Kazanan `/challenges/:id/taunt` çağırır, isterse bir şablon seçer.
3. Sunucu şablonun seviyesini **alıcının** `vulgarity_max` değerine kırpar. Seviye 3 bir kanka,
   seviye 1 seçmiş birine ancak seviye 1 laf sokabilir.
4. Metin `renderTaunt` ile gerçek isim ve skorlarla doldurulur.
5. Bildirim satırı yazılır (inbox), sonra push kuyruğuna girer.

Hangi laf havuzundan seçileceği her kaybeden için ayrı belirlenir (`tauntContextFor`). Rövanşı
alan, ilk çelıncta bu kaybedenin gerisinde kaldıysa `revenge` (`avengedAgainst`): ikisi de ilkini
oynamış olmalı. Rövanş lafı "geçen sefer yemişti, hesap kapandı" der; rövanşa sonradan eklenen bir
kankaya, grup çelıncında geçen sefer de yendiğin birine ya da seninle berabere kalana söylenirse
yalan olur. Aynı kankayı üst üste üçüncü kez yendiysen `streak`: arada bir beraberlik, bir kayıp ya
da başkasının kazandığı ortak bir çelınc seriyi bozar ve sayım bu çelınctan geriye yapılır
(`winStreakAgainst`). Geç atılan bir laf, sonradan gelen galibiyetleri de saymaz. İkisi de değilse
farka bakılır: `win_big`, `win` ya da `win_close`. Sonuç ekranı bu kelimeyi kazanana her kaybeden
için `tauntContexts` ile verir. Seçici RÖVANŞ ve SERİ laflarını ancak böyle gösterebilir, çünkü
telefon yalnızca skorları bilir.

Laf tek yönlü kalmaz. Kazanan konuştuktan sonra kaybeden **bir kere** cevap verebilir: yalnızca
kazanana ve yalnızca kazananın lafı ona ulaştıktan sonra. Cevap için ayrı bir tablo yok; `taunts`
satırı ters yönde yazılır ve `UNIQUE(challenge_id, from_user_id, to_user_id)` ikincisine izin
vermez (409 `already_replied`). `reply` şablonları kaybedenin ağzından yazılır ama `{winner}` yine
kazanandır, `{loser}` cevap veren. Beraberlikte kimse kazanmaz; birinciliği paylaşanlar birbirine
birer laf atabilir (`tie` şablonları), arkadan gelen kimseye bir şey diyemez. Beraberlik de yalnızca
birinciliği paylaşanlar arasındadır: arkadan gelen hepsine kaybetmiştir. Bitiş bildirimi ona
birincileri ve kaçıncı olduğunu söyler (`role: 'loser'`, `winnerId: null`; kazanan lafı vaat eden
`challenge_finished_lost` cümlesi olmadan), Karne ve haftalık özet onu `final_rank` > 1 diye yenilgi
sayar, sonuç ekranı, kart ve geçmiş de ona cezayı ve YEDİN'i ("Nazik"te KAYBETTİN'i) gösterir.
Kimin kime hangi hakla konuştuğuna rota karar verir (`tauntModeFor`). Cevapta ve beraberlikte
başka havuzdan istenen bir şablon o durumun kendi havuzundan biriyle değiştirilir: berabere biten
çelıncta "Ali koydu" yalan olurdu. Bildirim kimden geldiğini taşır (`fromUserId`), gelen kutusu yüzü oradan bulur.
Sonuç bekleyen bir çelınc (telefonların saati, itiraz) `finished` olmadığı için bu haklar da o
zamana kadar kapalıdır.

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
çelınca dair bir satırda çelınc listeleri, o çelıncın detayı ve sonucu (rövanş satırında eski
çelıncınki de: oradaki **Rövanş** düğmesi yeni rövanşa giden bağlantıya döner). Biten bir çelınc
ya da yeni bir rozet Profil'deki Sıralama'yı ve karneyi (`me`, sorgu önbelleğinde değil oturum
deposunda durur) da tazeler, kabul edilen bir kanka isteği Sıralama'yı. Sekmeler açık kalır ve odağa
dönünce kendiliğinden yenilenmez; o yüzden Gelen, rozetin gördüğü en yeni satır kendi en
üstündeki değilse kendini yeniler, Kankalar da listesi 20 saniyeden eskiyse sekmeye dönünce.
Profil de Sıralama 20 saniyeden eskiyse sekmeye dönünce onu ve karneyi birlikte yeniden okur:
bir kankanın kendi çelıncı bitince sana satır gelmez ama sıra değişir.
Bir bildirime dokunmak onu okunmuş sayar: push da telefonun kendi kopyası da satırın
`notificationId`'sini taşır.
Dokunuş (push, onun toast'ı, yoklamanın toast'ı, Gelen'deki satır) ekranı `router.navigate` ile
açar, `push` ile değil. Öndeki ekran zaten aynı yol ve aynı yol parametresiyse (`id`) yenisi
açılmaz; başka bir çelınc yine üstüne açılır. Eskiden açık çelınca dair bir "Dürtüldün" toast'ı ya
da bildirime ikinci dokunuş aynı çelıncı bir kez daha üst üste koyuyordu, geri tuşu da bir şey
yapmıyor gibi görünüyordu. Öndeki ekran yeniden kurulmaz, `invite` gibi arama parametreleri ona
yerinde verilir. Çelınc ekranı "Kanka ekle" penceresini bu yüzden `invite`'a göre anahtarlar
(`key`): açık çelınca dair bir "Kanka oldunuz" da pencereyi yeni kanka seçili açar; yoksa ilk
açılışta okunan `useState` değişmez, dokunuş bir şey yapmıyor gibi görünürdü. Gelen ve Kankalar
sekmelerine `goToTab` (`utils/navigation.ts`) ile gidilir: üstte bir ekran varsa önce sekme
çubuğuna inilir (`dismissAll`), sonra sekmeye geçilir. Çelınc ekranından bir sekmeye `push` ya da
`navigate` ikinci bir sekme çubuğunu çelıncın üstüne koyuyordu. Davet bağlantısı uygulamanın
dışında, kök yığında açılır: uygulama açıkken gelen bağlantı onun üstüne biner. Oradan
"Kankalara git" ve "Vazgeç" `leaveForTab` ile çıkar: önce bağlantıdan inilir (`dismissAll`), bir
sonraki turda `goToTab`. `replace` bağlantının yerine ikinci bir uygulama koyuyordu; iki sekme
çubuğu, iki ana ekran, geri tuşu da önceden açık çelınca dönüyordu. Uygulama kapalıyken
bağlantıdan açılışta altında bir şey yoktur, orada `replace` uygulamayı kurar. Karşılama
slaytları açıkken (`onboarding`) dokunuş hiçbir şey açmaz, satırı da okunmuş saymaz; satır Gelen'de
bekler. Slaytların üstüne açılan uygulama onları yığında bırakıyordu: slaytlar kapanmadığı için
karşılama bitmiş sayılmıyor, push kaydı, adım ve hatırlatmalar uygulama yeniden açılana kadar
kapalı kalıyordu.

Push kuyruğu ayrı bir tablo değil, gelen kutusunun `pushed_at` ve `push_error`'u boş satırlarıdır;
neyin hiç gitmeyeceği de orada yazılır. Bir telefon tek hesaba aittir: `POST /me/push-token` aynı
token'ı başka hesaplardan siler. Çıkıştaki DELETE'in gideceği garanti değil (sunucu o an uyuyor
olabilir), önceki hesabın davetleri ve lafları da çelınc adlarıyla birlikte telefonu devralan
kankada çalıyordu. Hesaba yeni gelen bir token sadece bundan sonra yazılanları alır: o an bekleyen
satırlar `before_token` olur, çünkü token yokken onları telefonun kendi kontrolü gösterdi ya da yeni
bir giriş onları zaten geçmiş sayar. Uygulama her açılışta aynı token'ı yine gönderir, bu hiçbir
şeye dokunmaz. Zamanlayıcının her turu da bir saatten eski bekleyen satırları `expired` diye kapatır
ve okunmuşları atlar. Eskiden kuyruğun sonu yoktu: Firebase sonradan açılınca kaydolan her telefona
aylarca birikmiş geçmiş 30 saniyede 200 satır yağardı, öteki kankaların taze "KOYDUM MU?"su da o
yığının arkasında beklerdi.

Hesapta push token için tek yer var ve o yer token'ı en son gönderen telefonundur. Çıkıştaki
`DELETE /me/push-token` eskiden orada ne varsa silerdi: yeni telefona geçen kanka eskisini
vermeden önce oradan çıkış yapınca yeni telefonu susardı, ne laf ne davet ne itiraz uyarısı
gelirdi, uygulama yeniden başlatılana kadar. Artık uygulama kendi kaydettiği token'ı gövdede yollar
(`{ token }`, hiç kaydetmediyse null: web, izin verilmemiş telefon) ve sunucu hesaptaki token ancak
oysa siler; cevaptaki `hasPushToken` yerin son halini söyler. Alanı bilmeyen eski uygulama gövdesiz
yollar, onun çıkışı eskisi gibi ne varsa siler. O yüzden NotificationBridge, token'ı bir kez
yolladıktan sonra her öne gelişte `/me`'ye bakar; `hasPushToken: false` görürse aynı token'ı yine
yollar. `/me` yerin dolu olup olmadığını söyler, kimin olduğunu değil: hesaba bağlı ikinci bir
telefon yeri tutuyorsa ona dokunulmaz, iki telefon da birbirinin token'ını sürekli ezmez.

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
  kaybeden de beklemiyor sayılır. Metin yalnızca hâlâ bekleyenlerin adını sayar;
* yalnızca kazananın attığı laflar sayılır. Bir kaybedenin cevabı ters yönde gider, ne
  hatırlatmayı susturur ne de tetikler.

Kazananın adına otomatik laf **atılmaz**; "KOYDUM MU?" kazananın hakkı, onun ağzından başkası
konuşmaz. Kaybedenin sonuç ekranı da dürüst olur: bitişten 24 saat sonra "bekle" yerine
"unuttu galiba, rövanş aç, bu sefer sen koy" der.

## Günlük hatırlatma

Sunucunun kendiliğinden gönderdiği tek "bugün gir" bildirimi: oyuncunun seçtiği saatten sonra
(`reminder_hour`, kendi saatiyle), yerel günde bir kez (`reminders_sent`). O gün elle bir şey giren
almaz. Telefonun kendi yazdığı satır (`DEVICE_SOURCES`: arka planda gönderilen adım, Android'in
ekran süresi) bu sayılmaz: sayılınca arka plan adım senkronu çalışan herkes adım yarışı boyunca hiç
hatırlatma almıyor, yanında oynadığı Şekersiz Günler boş kalıyordu. Ayrıca bugün hâlâ boş, giriş
alabilecek bir çelınc gerekir; telefonun saydığı bir çelınc senkron o günü doldurana kadar boş
sayılır (uygulamayı açmamış iPhone'cuya yine gider, adımlar uygulama açılınca gider). Telefon bugün
bir şey yazdıysa "Bugün hâlâ sıfırdasın" yalan olur: bildirim boş kalan çelınclardan bitişi en
yakın olanın adını söyler ("“Şekersiz Günler” bugün boş kaldı. Gir şuraya.") ve dokununca onu açar.

## Gün ortası dürtme

Arkadaşın seni elle dürtebilir. Asıl mesele kimsenin bakmadığı anda gelen bildirim: zamanlayıcı
her turda aktif çelınclara bakar ve geride kalana "o ne lan, Mahmut sana 8.229 adım fark koymuş,
kalk da iki dolaş" der. Çelıncı bir skor tablosundan gün içinde peşini bırakmayan bir şeye
çeviren kısım burasıdır.

Spam olmaması dört kurala bağlı:

* kişi başına yerel gün başına **bir** dürtme, kaç çelıncta geride olursa olsun. Geride olmak
  olağan hal; üç çelıncı olana her gün öğlen üç bildirim gitseydi tek çaresi Ayarlar'dan dürtmeyi
  kapatmak olurdu. O turda sırası gelen çelınclardan, farkın iki skordan büyüğüne oranı en yüksek
  olanı söyler, gerisini sayar: "Can sana 9.000 adım fark koymuş. Kalk da iki dolaş. 2 çelıncta
  daha gerideysin." Oran liderin skoruna göre değildir: ekran süresinde lider küçük sayıdadır ve
  60 dk'ya karşı 400 dk her seferinde 10.000 adıma karşı sıfır adımı ezerdi. Bahsi geçen her
  çelınc `nudges_sent`'e (`challenge_id`, `user_id`, `day_key`) yazılır; kişinin o gün için
  herhangi bir kaydı varsa gün kullanılmıştır, öğleden sonra geride kalınan yeni bir çelınc ikinci
  bildirim getirmez;
* saat penceresi **okuyanın kendi saat dilimine** göre 12:00–22:00 arasıdır;
* fark, lideri skorunun en az onda biri kadar olmalıdır — 40 adımlık fark hikâye değildir;
* check-in çelınclarında ve son bir saatte hiç gönderilmez, oralarda zaten kendi hatırlatması var.

Bunlardan ayrı, dürtmeyi kapatan (`users.nudges_enabled = 0`) hiç almaz. Bu kontrol `nudges_sent`
kaydından **önce** yapılır: kapatıp aynı öğleden sonra yeniden açan o günün dürtmesini kaçırmaz.

Dürtme engelin öbür tarafındakinin adını taşımaz. Fark, okuyanla arasında (kim kimi engellemiş
olursa olsun) engel olmayan, önündeki en iyi oyuncuya göre ölçülür; adı yazılan ve `fromUserId`
olan odur. Önceden hep lidere bakılıyordu: Ali'nin engellediği Veli'nin elle dürtmesi 403
`blocked` alırken sunucu her öğleden sonra Ali'ye "Veli sana 9 bardak fark koymuş" diyordu.
Öndekilerin hepsiyle arasında engel varsa yarış yine de sürüyor, dürtme de gelir: liderin farkı
sayılır ama bildirim kimseyi anmaz ("Bir rakibin sana 9 bardak fark koymuş"), `fromUserId` de
taşımaz.

Ekran süresinde henüz hiçbir gün girmemiş olan da dürtülmez: onun "farkı" girilmeyen günün
1440 dakikalık cezasıdır, kimsenin öne geçtiği yok. Bu kontrol de kayıttan önce yapılır; aynı gün
bir değer girip gerçekten geride kalan o günün dürtmesini alır. Kankanın elle dürtmesi de aynı
kurala uyar (`pokeTargetList`): "Ali 180 dk, sen 1.440" onun hiç yazmadığı bir sayıyı okurdu.
Çelınc ekranındaki "Laf sok" kartı o kankayı göstermez, rota da 403 `not_ahead` döner.

Evet/hayır çelıncında (`daily_boolean`) o günü işaretlemiş olan, cevabı evet de olsa hayır da
olsa, o çelınc için dürtülmez: günün tek işi işaretlemekti, öğleden sonra yapacağı hiçbir şey farkı
kapatmaz. Sabah işaretleyene öğlen "Bugünü işaretlemeyi unutma" gitmesi, dürtmeyi Ayarlar'dan
kapattırmanın en kısa yoluydu; geride kalınan bir gün de günlerce %10'un üstünde kaldığı için bu
her gün tekrarlanıyordu. Kontrol kayıttan önce yapılır: o gün başka bir çelıncta geride kalırsa
dürtme oradan gelir, işaretlenmiş çelınc "bir çelıncta daha" diye sayılmaz.

Kapanış cümlesi metriğe göre değişir: "kalk da iki dolaş" odak çelıncında saçmadır, orada
"telefonu bırak da bir seans yap" der. Sayı çelıncında (`manual_count`) bugün girişi olana
"Bugünkü girişini yapmayı unutma" denmez, daha fazlası istenir: "Biraz daha eklersen fark
kapanır." / "Biraz daha yap da gir şuraya." / "Bu kadarla olmaz, biraz daha koy." Günlük sınırı
dolmuş olana (giriş ekranının "tavan doldu" dediği gün) bu da denmez, o çelınc için hiç
dürtülmez: sunucu fazlasını `daily_cap` ile geri çevirir. Odak çelıncında bugünün 360 dakikası
dolmuşsa "kısa bir odak seansı" da istenmez, aynı sebeple. Bu kontrol de kayıttan önce yapılır.

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
* Haftalık adımda pazartesiden pazara her gün, telefonun okuduğu sayıyla o gün adım çelıncına elle
  yazılan ("Beyan et") sayıdan büyük olanı sayılır. Health Connect'i de Recording API'si de olmayan
  (Play hizmetleri eski) Android sadece uygulama açıkken sayar, çelınc da ona günün gerçek sayısını yazmasını söyler; özet yalnız telefona
  baksaydı ona haftasının küçük bir parçasını gösterir, en çok yürüyen diye de başkasının adını
  verirdi. Toplanmaz, büyüğü alınır: elle yazılan sayı o günün tamamıdır, telefonun okuduğu sayı her
  adım çelıncına aynı günün girişi olarak da yazılır, iki çelınc da aynı yürüyüşü iki kere tutar.
  İtirazla atılan (`rejected`) elle yazılmış gün sayılmaz, telefonun o gün okuduğu sayılır.
  Çelıncın kendisinin artık saymadığı elle yazılmış gün de sayılmaz: çelınctan çıkan oyuncunun
  yazdığı ya da oyuncu kalmadığı için iptal olan (`cancelled`) çelınca yazılan gün. Orada puan
  getirmez, itirazı da hiç sonuçlanmaz (itiraz saati yalnız aktif çelınctaki kabul etmiş oyuncu
  için işler): çıkıp gidenin yazdığı 100.000 `disputed` kalıyor, haftanın en çok yürüyeni diye onun
  adı veriliyordu. Adım rozetleri yine sadece telefona bakar: rozet geri alınmaz, elle yazılan gün
  ise sonradan itirazla atılabilir.
* Kral önce galibiyete, eşitse haftalık adıma bakar; ikisi de birebir eşitse taht paylaşılır.
  En çok yürüyen ise sadece tek başına öndeyse söylenir. Kral o hafta yediyse ya da berabere
  kaldıysa 3. seviye ona "hepsine koydun" demez, "N kere koydun" der: bir üst satır "1 kere
  yedin" derken kral satırı tersini söylemesin.
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

Sebebi basit: yirmi bir gri kare, yeni bir kullanıcıya "yapmadığın yirmi bir şey" listesi gösterir.
Bir sonraki basamak ise bu akşam ne yapacağını söyler. `badgeLadder(stats)` bu listeyi üretir,
`badgeLevel(family, earned)` de o merdivende kaçıncı basamakta olduğunu verir.

Rozetin adı da seviyeye uyar. Koyuş merdiveni 3. seviyenin diliyle adlanmış ("Çırak Saplamacı" 🍆 …
"Saplama Mühendisi"); "Nazik" seçen biri bunu telefonunu ailesi gördüğü için seçmiştir, ilk
galibiyetinde kilit ekranına patlıcan düşmemeli. O yüzden bu basamakların bir de kibar adı var
(`namePoliteTr`, `emojiPolite`: "İlk Zafer" 🏆, "Kazanmaya Alıştın", "Grubun Ustası", "Çelınc
Profesörü") ve adı her yerde `badgeTitle(badge, seviye)` verir: bildirimde alanın, profilde
okuyanın seviyesi. Anahtar (`koyus_1`) hiç değişmez; `badges` tablosundaki satırlar olduğu gibi kalır.
Merdivenin kendi adı da öyle: "Nazik" okuyan profilde "KOYUŞ" ve "YİYİŞ" değil "GALİBİYET" ve
"YENİLGİ" başlıklarını görür, sıralama da ona "en çok koyanlar" yerine "en çok kazananlar" der.

Adım merdiveni (`stepsSingleDayMax`) yalnızca telefonun saydığına (`steps_daily`) bakar: **Beyan et**
ile elle yazılan bir gün itirazla düşebilir, rozet ise bir kere verilince geri alınmaz. Haftalık özet
elle yazılan günü sayar, merdiven saymaz; o yüzden kilitli basamak bunu kendisi söyler ("Tek günde
7.500 adım at (telefonun saydığı)"), yoksa elle 25.000 yazan kanka neden 0/7.500'de kaldığını
anlamazdı. Odak merdiveni dakika sayar, kilitli basamağı da rozetin kendisi gibi dakikayla yazar
("Toplam 3.000 dakika odaklan", altında 1.280/3.000). Hedef saatle ("50sa"), ilerleme dakikayla
yazılınca okuyan 3.000 dakikanın 50 saat olduğunu kafadan hesaplıyordu.

Erken kalkma merdiveni (`checkinsStreakMax`) sadece **sabah** check-in'lerini sayar: açılış saati
öğleden önce olan türler, yani Erken Kalkan Koyar ve Yatak Toplama Sabahı
(`MORNING_CHECKIN_TYPE_KEYS`). Erken Yatma Sözü de bir check-in ama yedi gece "7 gün üst üste
zamanında kalktın" demek değil; geceler sabahların arasını da birleştirmesin. Ayrım çelıncın
saatine göre değil türe göre: bir Erken Kalkan çelıncının saati öğleden sonraya kurulabilir. Daha
önce gece check-in'leriyle verilmiş bir Horoz geri alınmaz; rozet verildiyse kalır.

Rövanş merdiveni (`revengeWins`, "Yediğini geri veriyorsun") yalnızca **ilkini kaybettiğin**
çelıncın kazandığın rövanşlarını sayar: ilkini başkası kazandıysa ya da berabere bitip sen
arkada kaldıysan (Karne'deki yenilgi kuralı). Kazandığın bir çelıncın rövanşını yine kazanmak
ya da ilkini oynamadan eklendiğin bir rövanşı almak ödeşmek sayılmaz. Eskiden her kazanılan
rövanş sayılıyordu; o sayımla verilmiş bir Faiziyle Aldı da yerinde kalır.

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

Klavye: uygulama Android'in her sürümünde kenardan kenara (edge-to-edge) çizilir, RN'in Modal'ı
da öyle. Klavye açılınca ekran artık küçülmez, klavye içeriğin üstüne biner. Bu yüzden
`Screen keyboard` ve her `Sheet` (alttan açılan kart), iOS'taki gibi Android'de de
KeyboardAvoidingView'i `padding` ile kullanır (`utils/keyboard.ts`). Yoksa alttaki alanlar da,
şifre ve sunucu adresi kartları da klavyenin altında kalır.

Toast'lar (üstte beliren kısa mesajlar) uygulamanın kökünde çizilir, ama `Sheet` bir Modal'dır:
telefonda kendi penceresi, web'de sayfanın en üstüne eklenen ayrı bir katman. Kökteki toast açık
kartın karartmasının altında kalıyordu; kartın kendi formundan gelen hata ne okunabiliyor ne de
dokunulabiliyordu. Şimdi açık her kart kendini `useToastLayer` ile bildirir, toast'ı en son açılan
kart kendi içinde çizer, kök yalnızca hiçbir kart açık değilken çizer. Kart açıkken başka ekrana
geçilirse (kartın içindeki toast'a ya da bir bildirime dokunmak) Android kartın penceresini ekranla
birlikte kapatır ama `visible` açık kalırdı; toast'lar o kaybolmuş pencereye çizilir, hiçbiri
görünmezdi. Kart artık ekranı arkada kalınca (`blur`) kendini kapatır ve katmanı hemen bırakır.

Bağlantı şeridi (`OfflineFrame`) de kenardan kenara çizimin altında kalıyordu: saatin ve kameranın
arkasında duruyor, dokununca bildirim perdesi iniyordu. Şerit artık durum çubuğunun arkasına kadar
uzanır, yazısını ve dokunulan yerini onun altına iter; şerit görünürken altındaki ekranlara üst
boşluk 0 diye söylenir ki her ekran aynı boşluğu bir daha bırakmasın. Şerit ekranları kendi
boyu kadar aşağı da iter; KeyboardAvoidingView yerini pencereye göre değil üstündeki görünüme göre
ölçtüğü için `Screen keyboard` bu boyu (`useOfflineStripHeight`) klavye payına ekler, yoksa
bağlantı yokken yazılan bir form (bodrumda girilen adım, şeridin açtığı sunucu adresi ekranı)
klavyenin o kadar altında kalırdı. Toast'lar şeridin dışında kalır ve gerçek boşluğu bilir.

Ekranın altı da aynı dertteydi: pencere Android'in gezinme çubuğunun da arkasına uzanır.
Samsung'larda sık görülen üç tuşlu çubuk (Geri, Ana ekran, Son uygulamalar) 48 dp tutar ve en
alttaki düğmenin, örneğin skor girişindeki "Kaydet"in ya da tanıtımdaki "DEVAM"ın, bir kısmını
örtüyordu. Sonu bir düğmeyle biten ekranlar artık `Screen safeBottom` ile bu boşluğu bırakır.
Kayan ekranda boşluk içeriğin sonuna eklenir: içerik çubuğun altından yine kayar, ama en aşağı
inince düğme çubuğun üstünde durur. Odak sayacı da artık kayar; küçük telefonda ya da büyük
yazıda duraklama kartı "Vazgeç"i aşağı itse bile ona ulaşılır. Sekmeli ekranlara eklenmez, çünkü
sekme çubuğu bu boşluğun üstüne zaten oturur; çelınc açma sihirbazının alt düğmeleri ve alttan
açılan kartlar da altlarını kendileri ayarlar.

## Bağlantı yokken

Giriş en çok çekmeyen yerde yapılır: bodrumdaki spor salonu, metro, merdiven boşluğu. Sunucuya
ulaşamayan (ya da 5xx alan) bir giriş atılmaz, `services/offlineQueue.ts` kuyruğuna girer; ilk
başarılı yazışta, uygulama açılınca, öne gelince ve arka plan görevinde sırayla gönderilir.
Sunucunun 4xx ile reddettiği giriş kesin reddir, kullanıcıya bir kez sebebiyle söylenir.

"Sunucu" derken bizim sunucumuz: o her hatayı `{ error: { code, message } }` zarfıyla döner. Arada
başka biri de cevap verebilir: bilgisayar uyurken Cloudflare tüneli 530'luk bir sayfayla, otelin
Wi-Fi'ı 200'lük bir giriş sayfasıyla, bir yönlendirici 403'le. Eskiden 200'lük sayfa boş cevap
sayılıyordu, yani kuyruktaki giriş "gönderildi" diye siliniyordu; zarfsız 4xx kesin ret sayılıp
atılıyor, zarfsız 401 de kankayı oturumdan atıyordu. Şimdi `lib/api.ts` bunları ayırır:
502/503/504/520-530 `server_down` ("Sunucu şu an kapalı, uyuyor ya da adresi değişmiş": penceresi
kapatılıp açılan tünelin eski adresi de uyuyan bilgisayarınkiyle aynı 530'u döner, o iş kendiliğinden
düzelmez, yeni bağlantı gerekir), gerisi `not_koydum` ("Bu
adreste KOYDUM sunucusu yok gibi"), 200'lük sayfa da durumu 0 olan bir `not_koydum`. Kuyruk ikisini
de bağlantı yokmuş gibi karşılar: giriş yerinde kalır, deneme hakkı yemez (bütün gece uyuyan bir
bilgisayar sekiz hakkı sabaha kadar bitirirdi), oturum kapanmaz. Tek istisna zarfsız 413: VPS'in
önündeki nginx kendi sınırını aşan fotoğrafı sunucuya varmadan geri çevirir, o da fotoğrafın
sorunudur. Giriş ekranı da ikisini bağlantı yokluğu sayar: o arada yüklenemeyen kanıt fotoğrafı
aşağıdaki gibi telefonda bekler, yoksa fotoğrafı zorunlu bir çelıncta bütün gece giriş yapılamazdı.

Reddedilen giriş de artık sessizce gitmez. Arka plan işleyicisi uygulama ekranda değilken de kuyruğu
boşaltıyordu; ekranda olmayan toast'ı kimse görmüyor, giriş yine de siliniyordu. Şimdi reddedilen
giriş kuyrukta bekler, uygulama öne gelince söylenir, ancak ondan sonra silinir. Söylerken hangi
çelınc ve hangi gün olduğunu da söyler ("“Adım savaşı” · Dün: Süre bitti, artık giriş yok."); giriş
kuyruğa çelıncın adıyla girer.

Kuyruk bir boşaltmada listeyi bir kez okur, ama bir fotoğraf iki dakika sürebilir ve uygulama o
arada açıktır: aynı gün doğrudan yazılmış (kuyruktaki kopyası silinmiş) ya da yeniden kuyruğa girmiş
olabilir. Eskiden elindeki eski kopyayı yine gönderiyordu: "Yaptım" kaydedildi denen gün sessizce
"Yapmadım"a dönüyordu. Şimdi her göndermeden hemen önce listeye yeniden bakar; giriş gitmişse ya da
aynı anahtarla yeniden girmişse (`queuedAt` farklı) dokunmaz, yenisi sonraki boşaltmada gider.
Kankanın o güne doğrudan yazdığı giriş henüz yoldayken de o günün kopyasına dokunmaz
(`holdParked`). Eskiden kuyruk o arada eski kopyayı da gönderiyordu, o da yenisinden sonra
varıyordu; sunucu günün son yazılanını tuttuğu için "Yapmadım"a düzeltilen gün yine "Yaptım"
kalıyordu. Doğrudan yazılan giriş cevabını alınca kopyayı siler, bağlantı yoksa kendi değerini
onun yerine kuyruğa koyar; kuyruk o güne ancak ondan sonra dokunur.
Sunucunun zaten yazdığı bir check-in'in tekrarı (409 `already_checked_in`) reddedilmiş değil,
gitmiş sayılır: ilk gönderim varmış, sadece cevabı kaybolmuştu.

Kuyruğa her dokunuş listenin tamamını okuyup geri yazar; AsyncStorage de her çağrıyı kendi yerel
iş parçacığında, sırayla cevaplar. Bağlantı gidince kuyruğun gönderdiği bardak da kankanın tam o
sırada bastığı "+1" de aynı anda hata alır. İkisi de listeyi öbürü yazmadan okuyordu, sonra yazan
da listeyi öbürünün değişikliği olmadan geri yazıyordu: kankaya "Sıraya alındı" denen bardak yok
oluyordu. Şimdi listeyi değiştiren her iş (kuyruğa alma, gidenin silinmesi, turun sonundaki
birleştirme, söylenen retlerin temizlenmesi) bir öncekinin bitmesini bekler (`mutateQueue`);
okumalar ve istekler beklemez.

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
Kuyruktaki her giriş, kaydedildiği anda telefonda oturum açmış hesabı taşır (`ownerId`). Hesap
istek yola çıkarken okunur, cevap gelince değil (`useAddEntry`): giriş ekranı istek yoldayken
kapatılabilir; Ali o arada çıkış yapsa ya da Veli girse de cevabı gelen giriş Ali'nin adına kuyruğa
girer, Ali'nin bekleyen kopyasını siler, ardından başlayan kuyruk turu da Ali'nin anahtarıyla
Veli'nin girişlerini göndermez. Aynı telefonda başka bir hesap açılınca kuyruk onun girişlerini
gönderir, öncekinin girişine ve fotoğrafına dokunmaz: yoksa Ali'nin günü ve fotoğrafı Veli'nin
anahtarıyla, Veli'nin girişi olarak giderdi. Ali geri girince onunkiler gider. Reddedilen girişin haberi de sahibine gider: Ali'nin
reddedilen girişi Veli'ye söylenmez, Ali geri girene kadar kuyrukta bekler. Eskiden telefona sonra
giren hesaba söylenip siliniyordu: Veli Ali'nin çelıncını görüyor, Ali hiç duymuyordu. Sıradaki
bir "Geldim"in üstüne basılan ikincisi ilk basışın saatini korur (`pendingForChallenge`); başka
hesabın bekleyen "Geldim"inin saatini almaz.

Yavaş bağlantı, bağlantısızlıkla karışmamalı. Eskiden fotoğraf da her istek gibi 15 saniyede
kesiliyordu. Kameradan 0,6 kaliteyle gelen 1,5-3 MB'lık bir fotoğraf, evdeki ADSL'in 1 Mbit
civarındaki yüklemesinde ya da zayıf 4G'de 15-25 saniye sürer: telefon internetteyken fotoğraf
zaman aşımına uğruyor, çekmiyormuş gibi kuyruğa giriyordu. Kuyrukta da zaman aşımı "bağlantı yok"
sayıldığı için kuyruk her turda orada duruyor, arkasındaki başka çelıncların girişleri hiç
gitmiyor, iki gün sonra "süre bitti" diye düşüyordu. Şimdi fotoğraf yüklemesinin iki dakikası var
(`UPLOAD_TIMEOUT_MS`; sunucu bir isteğin gelmesini 150 saniye bekler). O da yetmezse kuyruk `/health`'e
sorar: cevap yoksa bağlantı yoktur ve tur durur; cevap varsa bağlantı bu fotoğrafa yetmiyordur,
giriş fotoğrafıyla bekler ama arkasındakiler gider (`photoSlowTries`). Üçüncü yavaş turda fotoğraf
bırakılır, giriş onsuz gider; fotoğraf zorunluysa kullanıcı "Kanıt fotoğrafı gitmedi, bağlantı çok
yavaştı." diye duyar. Sunucu fotoğrafı bir süre almıyorsa (507 `disk_full`, 429 `upload_limit`)
giriş fotoğrafıyla bekler, deneme harcanmaz, arkasındakiler gider; ilk böyle cevaptan bir saat
sonra (`photoHeldSince`, `PHOTO_HOLD_MS`) fotoğraf bırakılır ve giriş onsuz gider, zorunluysa ret
sunucunun mesajıyla başlar. Sayaç tur değil zamandır: her öne gelişte ve her kaydedilen girişte
tur döner, sekiz deneme dakikalar içinde biter. 5 MB'tan büyük bir fotoğraf iPhone'da ve
tarayıcıda yüklenmeye hiç başlamaz, "Fotoğraf çok büyük" denir. Android'de fotoğraf seçicinin
bildirdiği boyut, kendi sıkıştırmasından önceki asıl dosyanınkidir: 7 MB görünen bir kamera
fotoğrafı sıkıştırılıp 2 MB gider. Orada kararı sunucunun 413'ü verir.

Ekranlar da bağlantı gidince ellerindekini bırakmaz. TanStack Query başarısız bir arka plan
yenilemesinden sonra `isError` der ama son veriyi tutar; çelınc ekranı, giriş ekranı ve odak
seansı bu durumda son bilinen hali göstermeye devam eder (ilk ikisi bunu küçük bir satırla söyler).
Hata ekranı yalnızca hiç yüklenmemiş, ya da sunucunun 404 dediği çelınc içindir.

Sabah check-in'i bunun yetmediği yer: telefon uygulamayı gece kapatır, hatırlatmaya dokunulunca
uygulama sıfırdan açılır ve TanStack Query'nin belleği boştur. Bilgisayar uyuyorsa ekran "Çelınc
gelmedi" diyordu ve **Geldim** sıraya alınamıyordu. Bu yüzden oynadığım, bitmemiş check-in
çelınclarının son detayı telefonda da durur (`services/savedDetails.ts`, en fazla beş). Bellek
boşken `useChallenge` sunucuya sormadan önce bu kopyayı koyar; istek düşerse ekran onu "son bilinen
hali" satırıyla gösterir, dokunuş da basıldığı saatle ve çelıncın kendi saat dilimindeki günüyle
sıraya girer. Kopya hesabındır: üstünde hangi hesabın okuduğu yazar, başka hesaba gösterilmez;
çıkışta, hesap silinince ve arka plan görevinin 401'inde `forgetStoredSession` onu da siler.

Kopya önce yalnızca çelınc ekranı açılınca yazılıyordu. Çelıncı açan, ikinci "varım"dan sonra ekranı
bir daha açmadıysa sabah kopyada "Kabul bekleniyor 1/2" görüyordu, **Geldim** yoktu; ana sayfadaki
kartta "Kabul" diyenin hiç kopyası olmuyordu. Oysa telefon 06:30 hatırlatmasını çelınc listesinden
kuruyordu. Şimdi kopya da aynı listeyi izler: her hatırlatma yenilemesinde (öne geliş, arka plan
görevi, her kabul) listedeki satır kopyanın çelıncını, oyuncularını ve beni günceller
(`syncSavedWithList`), kopyası olmayan check-in'in detayı bir kez okunur. Bir "evet" de sunucunun
cevabındaki detayı hemen saklar.

Aynı sabahın bir başka hali: başlangıç saati geçmiş, iki kişi kabul etmiş ama telefonun son gördüğü
detay hâlâ `pending`, çünkü sunucu onu bir sonraki turunda başlatacaktı ve o sırada uyuyordu. Çelınc
ekranı bunu "kabul bekleniyor" saymaz: bitişe kalan süreyi ve "Başlamış olmalı" satırını gösterir,
girişi de çalışan çelınctaki gibi alır; açtığı giriş formu ve odak sayacı da aynı kuralla
(`runningUnseen`) "aktif değil" demez. Sunucu giriş gelince önce vadesi gelen çelıncları başlattığı
için (`activateDueChallenges`) giriş reddedilmez. O satır sunucuyu ya da bağlantıyı yalnızca son
okuma başarısızsa ya da ekran telefondaki kopyadaysa suçlar ("sunucuya ulaşınca…"); sunucudan taze
gelen bir `pending` (telefonun saati birkaç saniye ileri) "birazdan burada da görünür" der.

Aşağı çekip yenilemenin çarkı yalnızca kullanıcı çektiğinde, o yenileme bitene kadar döner
(`hooks/usePullRefresh.ts`). TanStack Query'nin `isRefetching`'i 45 ve 60 saniyelik yoklamalarda,
push'un tazelettiği listelerde ve her adım senkronunda da doğrudur; çark ona bağlıyken her 45
saniyede kendiliğinden beliriyor, uygulama takılmış gibi görünüyordu.

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

Uygulama giriş ucuna (`POST /challenges/:id/entries`) hiçbir zaman cihaz kaynağı göndermez,
telefonlar yukarıdaki iki senkron ucunu kullanır. O uca cihaz kaynağıyla gelen bir giriş elle
hazırlanmış bir istektir ve senkronun kurallarından fazlasını alamaz: telefonun okuduğu bir günü
(adımda hiçbir günü) aşağı çekemez, itiraz edilen elle yazılmış bir sayının üstüne "telefon
okudu" yazamaz, itirazla düşmüş bir günü geri getiremez. Böyle bir istekte satır olduğu gibi
kalır, cevap yine 200 olur.

Telefonun bir güne okuduğu değer sadece büyür: adım da ekran süresi de. Ekran süresi modülü günün
başından şu ana kadarki ön plan süresini toplar; aynı gün için daha düşük bir okuma ya ikinci bir
telefondur ya da kullanım geçmişi silinmiş bir telefon, hiçbir zaman düzeltme değil. Bu yüzden
`screen_time_daily` günün en yüksek okumasını tutar (`MAX`) ve dağıtım da o sayıyı gönderir; 300'ün
ardından gelen 5 günü kimseye hediye etmez. Elle yazılmış bir günü telefon yine her durumda ezer,
küçük olsun büyük olsun; sadece telefonun kendi okuduğu bir gün aşağı inmez. `updated_at` sayı
değişmese de her senkronda yenilenir.

İtirazla düşen (`rejected`) elle yazılmış bir gün sıfırda kalmaz: telefonun o güne okuduğu değer,
yazılandan az da olsa, yerine geçer. Telefon o günü zaten gönderdiyse bu, itirazı haklı çıkaran
zamanlayıcı turunda olur (`restoreFromPhone`, bitirmeden önce): bitişten sonra düşen bir gün de
sonuca telefonun sayısıyla girer. Bu, `upholdDisputes`'un kendi işleminde, bildirimlerden önce
yapılır: sahibine "skorundan düştü" demek yalan olurdu, bildirim yazdığı sayıyla yerine geçen
telefon sayısını birlikte söyler, itiraz edenlere de telefonun sayısı gider. Burada günün kaç gün
önce olduğuna bakılmaz: senkrondaki 7 günlük sınır telefonun gönderdiği günler içindir, sunucuda
zaten duran sayı için değil. 14 günlük bir yarışın ilk gününe onuncu gün haklı çıkan itiraz da,
bilgisayar pazar gecesinden salıya uyurken süresi dolan itiraz da o günü 0'a indirmez; sonraki
hiçbir senkron da onu geri getiremezdi. Çelıncın gün aralığı ve bitiş kuralı (`dayOverByEnd`)
yine geçerlidir. Telefon o günü göndermediyse gün, senkronun 7 günlük sınırı içindeyse ilk
senkronda geri gelir; daha eskiyse hiçbir senkron göndermez, gün düşmüş kalır. İtiraz sürerken
telefon elle yazılmış satıra hiç dokunmaz; üstüne yazsaydı satır
"telefonun saydığı" olur, itiraz haklı çıkınca da gün bir daha geri gelmezdi. Değer ve kaynak
telefonunki olur, durum `ok`, kanıt fotoğrafı ve `answer_by` silinir; geri çekilmiş ya da
fotoğrafla kapanmış itirazlar unutulur, haklı çıkan (`upheld`) itirazlar `disputesWon` için
yerinde kalır. Adımda 0 hiçbir şeyi geri getirmez.
Telefonun kendi okuduğu bir gün düştüyse senkron ona dokunmaz, yoksa itiraz boşa giderdi. Geri
gelen adım gününe elle sayı yazmak 409 `day_rejected` alır, o günü artık sadece telefon yazar.
Telefonun sayısı yeni bir sayıdır ve "telefon" kaynağını gönderen de uygulamanın kendisidir:
itirazı kazanan kanka ona yeniden itiraz edebilir. Kişi başına bir itiraz satırı olduğu için
aynı satır yeniden açılır ve `won_before = 1` alır (göç 010); ilk kazanç `disputesWon`'da kalır,
gün de elle yazmaya kapalı kalır. Bu itiraz da haklı çıkarsa telefonun günü kalıcı olarak düşer.

`steps_daily` ve `screen_time_daily` her senkronu, çelınc olsun olmasın, saklar. Süren bir çelınca
sonradan katılan (ikinci gün eklenen ya da "Reddet"ini geri alan) kanka bu yüzden kabul ettiği
anda telefonunun zaten gönderdiği günleri alır (`backfillFromPhone`, kabulün kendi işleminde):
aynı dağıtım, aynı kurallar, sadece o çelınc için. Yoksa bir sonraki senkrona kadar 0'da
oturuyor, uygulama da ona "Eksik günü yaz" diyordu; ezberden yazılan sayılar da itiraz edilebilir
beyan satırlarına dönüşüyordu. Uygulama kabulün ardından bir kere de senkron olur
(`services/deviceSyncNow.ts`), telefonun hiç göndermediği günler için.

Bu iki tablonun `updated_at`'i her senkronda, sayı değişmese de, yenilenir; telefonun en son ne
zaman ses verdiğini o söyler. Süren bir çelıncın sıralamasında her kabul etmiş oyuncu için bunun
en yenisi `ParticipantView.lastSyncAt` olarak gider (`computeStandings`); uygulama 3 saattir ses
vermeyen bir rakibin barının altına "Telefonu 5 saattir ses vermiyor, sayı eski olabilir" yazar.
Bu çelıncta telefonun son sözünden sonra elle bir sayı yazmış oyuncuda `lastSyncAt` boş gider: o
artık yazıyordur (iPhone'a geçmiş, kullanım iznini kapatmış), bir ay önceki senkron onun
bugün yazdığı sayıyı bayat göstermemeli.
Entry'ler bunu söyleyemez: bir günün satırı o günün ilk senkronunda yazılır, adım günü ancak sayı
artınca değişir. Akış da aynı yüzden telefon satırının saatini `FeedItem.updatedAt`'ten (sayının
en son geldiği an) gösterir; `createdAt` gece yarısından hemen sonrasıdır. İtirazın adımları
(açılması, geri çekilmesi, kanıtla cevabı, yanması) sadece durumu değiştirir, bu yüzden telefon
satırında `updated_at`'e dokunmaz (`ITIRAZ_UPDATED_AT`, `services/entries.ts`): 15:00'te susan
telefonun sayısı 21:05'teki itirazla "21:05" görünmemeli. Uygulama bu saati de ekranın saatine,
yani son çekişe göre okur, sıralamadaki satırla aynı; React Compiler satırın sadece kendisinden
hesaplanan bir değeri satır değişene kadar saklıyordu ve susan telefonun satırı hiç değişmez.
Sıra ve sayfa imleci yine `createdAt`'te kalır. Bitişteki telefon saati (`everyPhoneReported`) bundan bağımsızdır, son
günün kendi satırına bakar.

Android'de adımın üç kaynağı var: Health Connect (izin verildiyse), Google Play hizmetlerinin
Recording API'si (`apps/mobile/modules/koydum-steps/`) ve uygulama açıkken sayım. Üçü yan yana
okunur, her gün için en büyüğü alınır; hepsi ancak eksik sayar, toplamak aynı adımı iki kere
sayar. Android 9'dan beri arka plandaki bir uygulama adım sensöründen hiç olay almaz; bu yüzden
uygulama kapalıyken saymanın tek yolu, sayımı Play hizmetlerinin yapması. Kayıt ilk izin anında
başlar; o günün öncesini uygulamanın ön planda saydığı değer tamamlar.

Uygulama ekrandan çıkınca expo-sensors sensörü bırakır ama başlangıç değerini tutar; geri
gelince ilk olay aradaki bütün adımları tek seferde getirir. Aynı gün içindeyse bunlar o günün
adımıdır, sayılır. Gece yarısını geçtiyse günlere bölünemez ve atılır: hepsini sabaha yazmak,
Recording API'nin akşamın gününe zaten yazdığı adımları ertesi güne bir kez daha yazıyordu,
sunucu da büyüğü tuttuğu için o gün bir daha düzelmiyordu. Günlük doğru sayı Health Connect'te
ve Recording API'de. İkisi de olmayan telefon (Play hizmetleri eski) bu sıçramayı yanlış güne
yazmak yerine tümden kaybeder: uygulama kenara atıldıktan sonraki akşamı da, geri açılmadan
önceki sabahı da. Onun sayısı zaten "yaklaşık" görünür, gerçek sayı için yanında Beyan et
vardır. Uygulama açıkken gece yarısını geçerse yalnızca birkaç adım düşer.

Health Connect Android 14'ten beri telefonla gelir, ama içine adım yazan bir uygulama (Samsung
Health, Google Fit) yoksa boştur ve her güne 0 der. O yüzden Health Connect'in 0'ı hiç
gönderilmez, son 7 günde adım görmeyen bir Health Connect de kaynak sayılmaz:
`getStepAvailability` o zaman telefonun kendi sayımını `hcEmpty: true` ile bildirir, ekranlar
"yaklaşık" etiketini ve "Beyan et"i ona göre gösterir. İzin düğmesi Health Connect'in izninden
sonra Fiziksel Aktivite iznini de ister; telefonun kendi sayımı bu izinle başlar.

Health Connect, ekranda olmayan bir uygulamaya ancak `READ_HEALTH_DATA_IN_BACKGROUND` izniyle
cevap verir. O izin yokken 15 dakikalık arka plan görevindeki her okuma sessizce düşüyor, yalnızca
telefonun kendi sayımı artıyordu: saatin yazdığı akşam koşusu, uygulama açılana kadar çelınca
gitmiyordu. İzin 1.1.1'in manifestinde. 1.1.0 aynı güncellemeyi aldığı için JavaScript onu
yalnızca `Application.nativeApplicationVersion` 1.1.1 ya da üstüyse ister. İzin düğmesi bunu,
içinde adım olan bir Health Connect'in Steps izninden sonra, ayrı ve kendi `try`'ıyla sorar: bu
özelliği tanımayan bir Health Connect isteği bütünüyle reddedebilir, birlikte sorulsa Steps izni
de giderdi. Daha önce izin vermiş olanlar için Ayarlar → Adım sayacı "Arka planda da okusun"
düğmesini gösterir.

Ekran süresinin Android tarafı `apps/mobile/modules/koydum-screen-time/` altında yerel bir Expo
modülüdür (Kotlin, `UsageStatsManager.queryEvents`). Uygulama onu adıyla arar
(`requireOptionalNativeModule('KoydumScreenTime')`), yoksa ya da izin verilmemişse sebebiyle
birlikte "okuyamıyorum" der ve ekran elle girişe döner. iPhone'da bu veri hiçbir uygulamaya
açık değildir; orada elle giriş kalıcıdır.

Ana ekran ve sistem arayüzü (`com.android.systemui`) Dijital Denge'deki gibi sayılmaz. Ana ekranı
bulmak manifestte bir `<queries>` MAIN/HOME girişi ister (modülün `app.plugin.js`'i ekler):
Android 11'in paket görünürlüğü onsuz yalnızca Ayarlar'ın FallbackHome'unu gösterir, 1.1.0'da
asıl ana ekran, uygulama listesi ve Pixel'in son uygulamalar ekranı bu yüzden sayılıyordu. Bir
uygulamanın aralığı ekran karardığında (`SCREEN_NON_INTERACTIVE`) kapanır, kilit ekranı
geldiğinde değil: geç kilitlenen telefonda ikisinin arası birkaç dakikadır.

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
bir telefon da 90. gün dışarıda kalmaz. Sunucu token'ı reddederse (401: şifre başka telefonda
değişti, sahibi sıfırladı, hesap kapandı) görev de uygulamanın çıkışını yapar
(`forgetStoredSession`, `clearReminders`) ve durur. Uygulama kaydırılıp kapatılmışken bunu fark
edecek başka bir şey yok; telefon ölü token'ı tutuyor, eski hesabın check-in alarmlarını iki hafta
çalmaya devam ediyordu. Çevrimdışı kuyruk yerinde kalır, bir sonraki girişi bekler.

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
bitişten sonra alarm yoktur, gün anahtarları da sunucunun saydığı gibi o çelıncın saat diliminde
(`myTimezone`, katılırken sabitlenen) sayılır. Sadece kabul edilmiş çelınclara kurulur,
cevaplanmamış bir davet çalmaz. "Geldim" sunucuya varınca o günün alarmı silinir; listeyi ondan
hemen önce okumuş bir yenileme de, uygulama açık kaldıkça, o günü geri kurmaz. Sıraya alınan
check-in'in alarmı kalır: check-in henüz sayılmadı
(ekran eskiden yine de "Saatinde geldin" diyordu, şimdi "Check-in gitmedi, sırada" der). Alarm
çalınca uygulama öne gelir ve kuyruk boşalır; bir şey gönderen her boşaltmadan sonra alarmlar bir
kez daha kurulur, yerine varan check-in kendi alarmını da götürür. Alarmlar her ön plana dönüşte, arka plan görevinde (uygulama kapalıyken
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
sorar. Ayarlar ekranını açmak düğme sayılmaz: açılışta ve telefonun ayarlarından dönüşte izne
sadece bakar, soran yalnız "Tekrar dene"dir.

Android 14'ten beri Health Connect telefonla gelir ve çoğu telefonda içine adım yazan yoktur. Adım
izninde Health Connect'e "evet", fiziksel aktiviteye "hayır" diyen birinin telefonu hiçbir şey
saymaz; bu yüzden boş bir Health Connect'in "evet"i tek başına izin sayılmaz
(`requestStepPermission` false döner) ve ekranlar telefonun ayarlarına giden yolu gösterir.

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
birinin token'ı depoya geri yazılmaz. Sunucu yine de bir token'ı reddederse (zarflı 401; aradaki
bir vekilin zarfsız 401'i kimseyi çıkarmaz, "Bağlantı yokken"e bak) uygulama çıkış yapar ve giriş
ekranı bir kereliğine nedenini söyler: 401'in kendi mesajını, mesaj yoksa "Oturumun düşmüş, bir
daha gir." der; önceden hiçbir şey demeden giriş ekranını gösteriyordu.

Şifre, Ayarlar → Hesap → "Şifreni değiştir"den değişir (`POST /me/password`). Yanlış girilen
mevcut şifre 401 değil 400 `wrong_password` döner, çünkü uygulama her 401'de çıkış yapar; bir
yazım hatası o anki oturuma mal olmamalı. Buradaki tahmin hakkı da girişteki kadardır: hesap
başına 15 dakikada 8 yanlış.

Şifre değişince başka telefonlardaki oturumlar kapanır. Kankalar birbirinin telefonundan hesabına
girer, herkes "123456" ile başlar; eskiden orada açık kalan bir oturum yeni şifreden sonra da laf
sokabiliyor, çelıncı reddedip "tırstı" dedirtebiliyor, hesabı silebiliyordu. İptal listesi yerine
her kullanıcının bir `token_version`'ı var (migration 012) ve her token imzalandığı andaki sürümü
`ver` olarak taşır; `authenticate` ikisi tutmazsa 401 `unauthorized` döner, mesajı "Şifren
değişti, bu telefondaki oturum kapandı. Yeni şifreyle gir." Şifre değişimi de sahibin sıfırlaması
da `replacePassword`'dan (`services/accounts.ts`) geçer ve sürümü bir artırır. Sahibin
sıfırlaması push token'ı da siler, çünkü o token dışarı atılan telefonlardan birinindir ve o
telefonun kendi çıkışı artık 401 alıp onu silemez. Telefondan yapılan değişimde uygulama kendi
kaydettiği push token'ı (`pushToken`, yoksa null) da gönderir: hesaptaki token oysa kalır, değilse
silinir. Alanı göndermeyen 1.1.0 uygulamada token olduğu gibi kalır: o sürüm cihaz token'ını
oturum başına değil, çalıştığı süre boyunca bir kez yollar; silinseydi telefon yeniden
başlatılana kadar ne push alırdı ne de kendi bildirimini gösterirdi (depoda token var diye push'un
geldiğini varsayıyor). Şifreyi değiştiren telefon cevapta yeni sürümle imzalı bir token alır;
NotificationBridge push token'ı oturum başına bir kez gönderdiği için aynı cihaz token'ını yeni
oturumla yeniden yollar. `ver` taşımayan eski token'lar 0 sayılır, her hesap da 0'dan başlar; yani
güncellemenin kendisi kimseyi dışarı atmaz. `/auth/refresh` sürümü korur, açık kalan bir oturum
kendini yenileyerek de kurtulamaz. Uygulamada bir 401 ancak istemci mağazadaki token'la kurulduysa
çıkış yaptırır: şifre değişirken yolda olan eski token'lı bir istek, şifreyi değiştiren telefonu
dışarı atmamalı.

Kullanıcı adının tek bir yazımı var: `foldUsername` (`packages/shared/src/text.ts`) küçültür,
Türkçe harfleri ASCII'ye çevirir (ş→s, ı→i, İ→i), kalan aksanları, boşlukları ve görünmez
karakterleri atar. Kayıt, giriş ve kullanıcı adıyla arkadaşlık isteği şemada bundan geçer,
`npm run yonet -- sifre` de aynısını kullanır. Kayıt ekranı kutuya yazılanı anında çevirir, kişi
neyin kaydedileceğini görür. Eskiden "şeyma" "küçük harf olmalı" diye reddediliyordu, oysa ş da
küçük harf. `toLowerCase()` ise "İsmail"i i + U+0307 + "smail" yapıyordu, bu da hiçbir hesapla
eşleşmiyordu. 1.0 uygulaması hâlâ öyle gönderir, sunucu çevirdiği için girer.
Var olan adlar zaten ASCII, geçiş gerekmedi. Arama da sorguyu böyle çevirip kullanıcı adına bakar:
"Çağ" yazan @cagri'yi bulur. Görünen ad Türkçe harfleriyle kalır.

Görünen ad ise tek satırdır (`DisplayNameSchema`): görünmez karakterler, kontrol karakterleri ve
yön değiştiren bidi işaretleri atılır (emojileri birbirine bağlayan ZWJ kalır), satır sonları tek
boşluğa iner (`singleLine`). Sağdan sola çeviren bir U+202E, adın geçtiği her bildirim satırının
geri kalanını ters çeviriyordu. Sadece Hangul dolgu harflerinden (U+3164, oyuncuların bildiği "görünmez nick") ya da boş braille
karakterinden oluşan ad "Görünen ad boş olamaz" alır (`hasVisibleChar`). Çelınc başlığı, ödül,
ceza ve elle yazılan laf da aynı temizlikten geçer; girişin notu satır sonlarını korur. Zaten
kayıtlı adlara dokunulmadı; böyle bir ad, sahibi Profil'den adını yeniden kaydettiğinde temizlenir.

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
elinde tutar. Sunucu çökerse aynı `PUBLIC_URL` ile yeniden açar (1, 5, 15 saniye sonra). On
dakikada beşinci çöküşte eskiden bırakıp tüneli de kapatıyordu; sebep çoğu zaman bir dakikada
düzelen bir şeydi (portu tutan unutulmuş bir `npm run server`, `git pull`'dan sonra eksik kalan
bir paket) ama adres herkes için gitmiş oluyordu. Artık beş dakika bekleyip yeniden dener
(`y` + Enter beklemeden açar); tünel ve adres yerinde kalır. cloudflared kapanırsa (çoğu zaman ev interneti gitmiştir)
sunucuya dokunmaz, evdeki Wi-Fi ve zamanlayıcı çalışmaya devam eder; tüneli 5 saniyeden bir
dakikaya uzayan aralıklarla yeniden dener, yeni adres gelince sunucuyu onunla yeniden başlatır.
Sunucuyu durdurmak için sinyal değil IPC mesajı gönderir: Windows'ta bir alt sürece sinyal
göndermek TerminateProcess demektir, ne veritabanı kapanır ne yarım kalan iş biter. Sunucu da
kapanırken zamanlayıcının o anki turunu bekler (en çok 10 saniye): yarıda kesilen bir push
gönderimi satıra `pushed_at` yazamaz ve bir sonraki açılışta aynı KOYDUM ikinci kez gider.

Güncelleme de aynı sebeple pencereyi kapatmadan olur. Betik stdin'i satır satır okur:
`y` + Enter sunucuyu aynı tünelin arkasında yeni kodla yeniden açar, `dur` + Enter onu durdurup
bekletir (Windows'ta çalışan sunucunun açık tuttuğu `better_sqlite3.node`'u `npm install`
değiştiremez). readline `terminal: false` ile, çıktısız kurulur: stdin ham moda geçmez, Ctrl+C
hâlâ SIGINT olarak gelir. Yeni kod açılamazsa İngilizce bir yığın izi yerine ne yapılacağı
Türkçe yazsın diye sunucunun girişi (`src/index.ts`) asıl açılışı (`src/main.ts`) `import()`
ile yükler: statik bir import'ta eksik bir paket bizim kodumuz hiç çalışmadan patlıyordu.
Eksik bir pakette ve başka bir Node.js için derlenmiş better-sqlite3'te sunucu 3 koduyla çıkar;
betik bunu çöküş saymaz, saniyeler içinde aynı duvara çarpacak denemelere girmeden bekler.

## Davetle gelen kanka

Kankalar → Paylaş'ın gönderdiği bağlantı davet edenin kendi kodunu taşır. Eskiden bağlantıyla
kaydolan yeni oyuncu bir kanka isteği gönderiyordu ve davet eden uygulamayı açıp **Kabul**'e basana
kadar bekliyordu: ana sayfası "Önce bir kanka ekle", sihirbazın Kankalar adımı "Kanka yok" diyordu,
davet eden de onu süren çelıncına çağıramıyordu (`requireFriend`). Push'u olmayan bir telefonda bu
15 dakikalık arka plan kontrolüne, çoğu zaman sabaha kalıyordu; yeni gelen de orada bırakıyordu.

Artık kodla gelen istek, gönderen hesap en çok bir haftalıksa (`INVITE_AUTO_ACCEPT_MAX_AGE_MS`,
telefonun bekleyen daveti tuttuğu hafta) hemen `accepted` olur ve davet edene `friend_accepted`
gider (`via: 'invite'`). Kodu paylaşan onu kime istediyse ona verdi, "evet" o an verilmiş sayılır.
Hafta sınırı eski bir hesabın sorulmadan gelmesini engeller: o hâlâ istek gönderir. Ama insanın
arkadaşlıktan çıkardığı ya da isteğini reddettiği kişi çoğu zaman tam da bağlantıyla gelmiş yeni
hesaptır, kod da hâlâ bağlantısındadır: arkadaşlık silinir, hafta dolmamıştır, kod onu ertesi gün
sorulmadan geri getiriyordu. Bu yüzden "hayır" saklanır (`friend_refusals`: çıkarma, **Reddet**,
engel). Kodun sahibi bir kez hayır dediyse o kişinin kodla gelişi ne kadar yeni olursa olsun
sıradan bir istektir; sahibi ona kendisi istek atınca ya da isteğini kabul edince hayır kalkar.
Engel iki yönde de 403 kalır, ama engellenen yeni bir hesap açıp eski bağlantıyla gelebilirdi:
engel artık engelleyenin davet kodunu da yeniler (`renewInviteCode`), eski bağlantı kimseyi
bulmaz. Uygulama yeni kodu /me'den okur ve "Davet bağlantın da yenilendi" der; eski bağlantıyla
henüz gelmemiş biri varsa ona yenisini Paylaş'la göndermek gerekir. Kod altı karakter, 32 karakterlik bir
alfabeden; doğru bir tahmin artık bir arkadaşlık demek. Bu yüzden bir hesabın kimseyi bulamayan
kodları saatte 20 ile sınırlı (`INVITE_CODE_MISSES_PER_USER`, süreç içi `AttemptLimiter`), sınırı
aşan doğru kodla gelse de bekler.

Yeni kanka çoğu zaman süren bir grup çelıncının beklediği kişidir, ama "kanka oldunuz" haberi
("Aç bir çelınc, koy bakalım") ve dokununca açılan Kankalar sekmesi ikinci bir çelınca itiyordu.
Her `friend_accepted` artık okuyanın yeni kankayı hemen çağırabileceği çelıncları arar
(`invitableFor`: davet ucunun kuralları, hata vermeden okunur) ve en erken biteni varsa adını
söyler ("“Ofis Ligi” çelıncına çağır, grubu bölme."), `challengeId` de dokunuşu oraya, yeni kanka
seçili "Kanka ekle"ye götürür. Kabul eden taraf aynı listeyi `/accept` cevabında (`invitable`) alır
ve uygulamanın "Kanka oldunuz" uyarısı aynısını söyler; listeyi göndermeyen eski sunucuda uygulama
kendi çelınc listesine bakar.

Uygulamada giriş ekranındaki "Önce sunucuyu seç"e yapıştırılan davet bağlantısı kayıt ekranına
geçirir: sunucu seçmemiş bir telefon yeni birinin telefonudur, giriş formu ona ancak "şifre yanlış"
derdi. Hesabı olan, kayıt formunun altındaki **Giriş yap**'a basar.

## Neden SQLite

Bu uygulamanın kullanıcısı bir arkadaş grubudur, on binlerce kişi değil. Tek dosyalık bir
veritabanı yedeklemesi kolaydır (`cp koydum.db yedek.db`), ORM yoktur, migration'lar kodun
içinde string olarak durur ve açılışta bir transaction içinde uygulanır. Sorgu sayısı azdır ve
hepsi hazırlanmış ifadelerdir.

## Bir isteğin ağırlığı

Sunucu tek bir Node sürecidir: bir isteği saniyelerce işlemek, o arada bütün kankaların isteğini
bekletmek demek. Eskiden bir JSON gövdesi 6 MB olabiliyordu. 3 MB'lık bir `{}` listesi sunucuyu
14 saniye kilitliyor, belleğini 3 GB'a çıkarıyor, 279 MB'lık bir hata cevabı döndürüyordu;
`/auth/login`'e giden iç içe `[[[…]]]` için hesap bile gerekmiyordu. Şimdi bir JSON gövdesi en
fazla 64 KB olabilir (`JSON_BODY_LIMIT`, `src/app.ts`); fazlası okunmadan 413 `body_too_large`
alır, kimden gelirse gelsin. Şemaların kabul ettiği en büyük gövde, 500 kimlikle
`/me/inbox/read`, 33 KB civarındadır; uygulamanın gönderdikleri birkaç KB. Kanıt fotoğrafı bu
sınıra girmez: multipart kendi akışını okur ve kendi 5 MB'ını tutar.

Multipart'ın kendi sınırı yalnızca dosyaya bakıyordu. busboy'un varsayılanıyla fotoğrafın önünde
1.000 parça, her biri 1 MB'lık metin alanı gelebiliyordu ve hepsi istek bitene kadar bellekte
duruyordu: bir hesap 99 alanlık istekleri Cloudflare'in 100 MB sınırının hemen altında yarıda
bıraktı, birkaç düzinesi süreci belleksiz bıraktı. Uygulama yalnızca `file` gönderir; şimdi
fotoğrafın yanında en fazla 4 alan, her biri en fazla 1 KB okunur (`MULTIPART_LIMITS`), fazlası
400 `too_many_parts`. Fastify'ın varsayılanı bir isteğin gelmesini sonsuza dek beklemekti; artık
150 saniyede gelmeyen istek kesilir (`REQUEST_TIMEOUT_MS`), uygulamanın fotoğrafa verdiği iki
dakikanın biraz ötesi.

Sınır tek başına yetmiyordu: zod bir listenin uzunluğuna ancak bütün elemanlarını okuduktan sonra
bakar ve her bozuk elemanı ayrı bir hata sayar, 64 KB'lık bir `{}` listesi bile megabaytlarca
cevap döndürüyordu. Bu yüzden sınırı olan listeler (`days`, `participantIds`, `userIds`, `ids`)
önce sayılır (`boundedArray`, `packages/shared/src/schemas.ts`): fazla uzunsa tek bir hata çıkar,
elemanlarına hiç bakılmaz. 400 `validation` cevabı da en fazla 20 hata listeler; uygulama zaten
yalnızca mesajı gösterir.

## Şifre tahmini

Giriş her denemede bir scrypt harcar ve üç sayaçtan geçer (`routes/auth.ts`, süreç içi
`AttemptLimiter`): bir istemciden 15 dakikada 40 yanlış, bir istemciden aynı kullanıcı adına 15
dakikada 8 yanlış, bir hesaba her yerden toplam bir saatte 30 yanlış. Her deneme scrypt'ten önce
sayılır, doğru şifre sayaçları sıfırlar. İlk ikisi tek başına yetmiyordu: tünelin arkasında
istemci `X-Forwarded-For`'dan okunur ve bir IPv6 kullanıcısının elinde koca bir /64 vardır. Her
denemeyi yeni bir adresten gönderen biri bir hesaba saniyede 62 şifre deneyip sonunda doğrusuyla
giriyordu. Artık bir IPv6 istemci kendi /64'üdür, `::ffff:` ile yazılmış bir IPv4 de düz IPv4
(`clientKey`, `services/throttle.ts`; kayıt ve davet sorguları da aynı anahtarla sayılır). Adres
değiştireni hiçbir adres sayacı durduramayacağı için üçüncü sayaç hesabındır.

Bunun bedeli, bir yabancının bir kankanın girişini saatte 30 yanlış şifreyle kapalı
tutabilmesidir. Girmiş telefonlar etkilenmez (oturum `/auth/refresh` ile tazelenir, girişten
geçmez), 429 da çıkış yolunu söyler: sunucuyu açan `npm run yonet -- sifre` ile yeni şifre verir.
Sayaç hesabın kimliğine ve `token_version`'ına bağlı olduğu için yeni şifre, Ayarlar'dan
değiştirilen de, kilidi hemen açar. Olmayan bir kullanıcı adı kendi yazımıyla aynı sayaca girer;
ikisi aynı kilitlenir, 429 kimin var olduğunu söylemez.

Sayaç tablosu en fazla 5.000 anahtar tutar. Dolunca eskiden ilk gördüğü anahtarı atıyordu, yani
yarım dakikalık 5.000 uydurma deneme kilitli bir hesabı açıyordu. Şimdi en az denemesi olanı,
onlardan da en uzun süredir dokunulmayanı atar: saldırı altındaki bir anahtarı silmek için her biri
onun kadar denemesi olan 5.000 anahtar gerekir.

## Fotoğraflar ve disk

Kanıt fotoğrafları veritabanıyla aynı diske yazılır (`UPLOAD_DIR`, varsayılan `data/uploads`) ve
hesap açmak için sunucuya ulaşmak yeter. Hesap başına saatte 60 fotoğraf tek başına yetmiyordu:
aynı adresten açılmış iki yeni hesap 3,3 saniyede 600 MB yazdı, hiçbir girişin göstermediği bir
fotoğraf da ancak bir hafta sonra silinir. Disk dolunca zarar fotoğraflarda kalmıyordu: bir
kankanın adımları üç kez 500 aldı ("database or disk is full"), yeni hesap açılmadı, günün yedeği
yazılamadı.

Şimdi `POST /uploads` (`routes/uploads.ts`) dört yerde durur. Saatte 60 fotoğraf hem hesap hem
istemci başına sayılır (`clientKey`: IPv4 adresi ya da IPv6 /64'ü), ikinci hesap açmak bir şey
kazandırmaz. İkisi de gövde okunmadan, ilk `await`'ten önce sayılır, fotoğraf saklanmazsa geri
verilir: önce yalnızca yazılan fotoğraf sayılıyordu, aynı anda gönderilen 150 fotoğrafın hepsi
gövdeleri gelirken kontrolden geçip 201 aldı. Bütün sunucu 24 saatte en fazla 2 GB fotoğraf alır (`uploadDailyBudgetBytes`); adres
ve hesap çoğaltana karşı tek sınır budur. Baytlar dakika dakika toplanır, liste 1.440 kayıttan
uzamaz. Yazmadan önce ayrılırlar ki aynı anda gelen fotoğraflar hep birlikte sınırın altından
kaçmasın; yazma başarısız olursa geri verilirler. Gövde okunmadan önce de diskte
`UPLOAD_MIN_FREE_MB` (varsayılan 2048) kadar boş yer olup olmadığına bakılır
(`fs.promises.statfs`, Windows'ta NTFS'te de çalışır; sistem söyleyemezse bu kontrol atlanır).
Altındaysa 507 `disk_full`: kalan yer veritabanının, adımların ve yedeğindir. Yazarken disk dolarsa
(`ENOSPC`, `EDQUOT`) yarım dosya silinir, cevap yine 507'dir. Sayaçlar giriş sayaçları gibi
süreçtedir, yeniden başlatma onları sıfırlar.

Sunucuyu açan durumu pencerede okur: dolmak üzere olan disk için de dolan gün için de saatte bir
`warn` satırı. Bir 507 ayrıca "istek patladı" diye yazılmaz, yoksa reddedilen her fotoğraf bir
satır olurdu. 507 bizim zarfımızla gelir, `useProofPhoto` mesajı olduğu gibi gösterir. Kuyruk
onu önce her 5xx gibi sonra yine deniyor, her turda sekiz denemeden birini harcıyordu: disk dolu
kaldıkça bodrumda sıraya giren girişler fotoğrafıyla birlikte "çok denedim" diye düşüyordu. Artık
507 ve 429 deneme saymaz, fotoğraf bir saat bekler, sonra giriş onsuz gider (bkz. Bağlantı
yokken). Telefonda kalan bir fotoğrafla bağlantı varken **Kaydet**'e basılırsa da 507 sıraya
girmez: giriş formu disk mesajını gösterir, fotoğraf kaldırılıp giriş hemen gönderilebilir.

Disk yine de tamamen dolabilir: fotoğraf dışında büyüyen bir şey, bilgisayardaki başka bir program.
O zaman her yazma SQLite'ın İngilizce "database or disk is full" hatasıyla (`SQLITE_FULL`)
patlıyordu, okumalar da: `authenticate` dakikada bir `last_seen_at` yazar, oturum açmak da yazar; bir
dakika sonra bütün grubun ekranları da oturum açması da 500 aldı. Telefonların kuyruğu her 500'de sekiz denemeden
birini harcadı, sunucuyu açan da pencerede her 30 saniyede bir aynı İngilizceyi gördü; kimsenin
aklına disk gelmedi. Artık `last_seen_at` yazılamazsa atlanır (onu yalnızca `yonet kullanicilar`
gösterir); liste ve çelınc ekranının okurken başlattığı, saati gelmiş bir çelınc de yer açılana kadar
`pending` kalır, yoksa o tek çelınc yüzünden herkesin ana sayfası 507 alıyordu. Diskin dolduğunu
söyleyen her hata (`SQLITE_FULL`, `ENOSPC`, `EDQUOT`; `services/disk.ts`) hata işleyicide 507
`disk_full` olur: "Sunucunun diski doldu, şimdilik hiçbir şey kaydedilemiyor. Sunucuyu açan
kankana haber ver." Kuyruk girişin kendisine gelen 507'de bağlantı yokmuş gibi durur, deneme
saymaz. Sunucuyu açan saatte bir Türkçe "disk doldu (N MB boş): …" satırı görür; zamanlayıcının
dolu diske çarpan bütün yazmaları da (son vuruş, uyku kaydı, tur, push) kendi satırları yerine
buraya gider. Günün yedeği sığmazsa yarım dosyası silinir, bir saat sonra yine denenir, pencerede
ne kadar yer istediği yazar. `geri-yukle` da önce boş yere bakar: yedek artı 10 MB yoksa "Diskte
yer yok" der. Bakmasa dolu diskte açıp kapattığı veritabanının WAL'i geri katlanamaz, `geri-yukle`
da sunucu açık sanırdı. Yer açılınca SQLite bir sonraki yazmada yine yazar, yeniden başlatma
gerekmez.

Arkadaşı olmayanı fotoğraftan men etmek işe yaramazdı: yeni bir hesap iletilmiş bir davet
bağlantısıyla hemen arkadaş olur. Fotoğrafın içine de bakılmaz: başı JPG, PNG ya da WEBP gibi
başlıyorsa gerisi çözülmeden saklanır (`services/images.ts` yalnızca üst veriyi atar). Başlığın
arkasındaki çöp `nosniff` ve `sandbox`'lı CSP ile sunulur, resimden başka bir şey olarak açılamaz;
asıl tehlike diskin dolmasıydı.

## Çöp hesaplar

Hesap açmak için sunucuya ulaşmak yeter, kullanıcı adıyla kanka isteği de herkese gidebilir. Bir
istemci 10 dakikada 120 hesap açabiliyordu, saatte 720. Aynı adresten açılan 50-110 hesabın her biri
aynı kişiye istek attı, her biri onun telefonunda bir push oldu ("BOB HIRSIZ 7 seni kanka listesine
ekledi"). Bir /64'ten açılan 2.100 hesaptan sonra da "Şey" ve "şeyma" aramaları @seyma'yı bulamadı.

Artık bir istemci (`clientKey`: IPv4 adresi ya da IPv6 /64'ü) saatte en çok 20 hesap açar
(`registrationsPerHourPerClient`, `src/config.ts`). Arkadaş grubu birkaç kişi birden kaydolur,
aynı Wi-Fi'daki bir masa bile bu sınıra varmaz. Sayaç, şifre hash'lenmeden hemen önce işler:
kapılmış bir ad ya da hatalı bir form sayılmaz, aynı Wi-Fi'dan kaydolanlar yeniden denedi diye
birbirinin hakkını yemez. Ad, hash bittikten sonra eklemeden hemen önce bir kez daha aranır: aynı
boş adı aynı anda isteyen iki telefondan ikincisi 500 alıyordu, artık "kapılmış" der ve hakkını
geri alır. Bütün sunucu için ayrıca bir sınır
konmadı: onu tek bir trol doldurur, gerçek yeni kankalar kapıda kalırdı. Kullanıcı adıyla gönderilen
yeni istekler de hesap başına saatte 15 (`NEW_FRIEND_REQUESTS_PER_USER`, `routes/friends.ts`). Kişi
başına günde 3 istek bir telefonu öttüreni durduruyordu, herkesi öttüreni değil. Grubu elle ekleyen
yeni biri buna sığar. Davet koduyla gelen istek sayılmaz, kodu sahibi verir (kimseyi bulamayan kodlar
zaten ayrıca sayılır); önce istemiş birine "evet" demek de yeni istek değildir. Sayaçlar giriş
sayaçları gibi süreçtedir, yeniden başlatma onları sıfırlar.

Aramada sorun eşleştirmenin sırasıydı. SQLite'ın `lower()`'ı ve LIKE'ı yalnızca ASCII bilir; Türkçe
harfli bir sorgu SQL'de daraltılamaz, önek boş kalır, LIKE `%` olur. Türkçe eşleştirme
(`matchesPrefix`, `routes/users.ts`) ise JavaScript'te, kullanıcı adı sırasıyla ilk 2.000 satırda
çalışıyordu; "aa…" diye başlayan 2.100 hesap @seyma'yı o 2.000'in dışına itti. Şimdi aynı
fonksiyon SQLite'a verilir (`koydum_search_match`; bir fonksiyon açıldığı bağlantıya ait olduğundan
her uygulama kendi `db`'sine bir kez kaydeder) ve sorgunun içinde, LIMIT'ten önce çalışır. Sıra da
LIMIT'ten önce kurulur: önce sorgunun kendisi olan kullanıcı adı, sonra onunla başlayan kullanıcı
adları, sonra yalnızca görünen adı tutanlar. Yalnızca kullanıcı adına göre sıralanınca görünen adı
"Seyma" olan 20 hesap (@a01…@a20) "seyma" aramasında @seyma'yı yine dışarıda bırakıyordu; artık
tam kullanıcı adını hiçbir kalabalık gizleyemez. "şey" gibi kısa bir önek ise onunla başlayan
herkesindir, ilk 20'si döner. Migration gerekmedi.

Adın kendisi de bir yoldu. "seni öldürürüm" adıyla açılan bir hesabın kanka isteği kurbanın kilit
ekranına "seni öldürürüm seni kanka listesine ekledi" diye düşüyordu; laf filtresi
(`containsBanned`, `packages/shared/src/banned.ts`) yalnızca özel lafa bakıyordu. Artık kullanıcı
adı ve görünen ad kayıtta, görünen ad `PATCH /me`'de, çelıncın başlığı, ödülü ve cezası da
`POST /challenges`'ta aynı filtreden geçer (`assertCleanName`, `assertCleanTitle`, `services/moderation.ts`). Ret 400
`banned_content`'tir, mesajı hangi alanın değişeceğini söyler ("Bu ad olmaz. … Adını değiştirip
tekrar dene."). Kontrol zod şemasına konmadı: şemanın 400'ü hep "Gönderdiğin bilgiler geçersiz."
der, uygulama da yalnızca mesajı gösterir. Yalnızca yeni yazılan denetlenir: eski satırlara
dokunulmaz, `PATCH /me` aynı adı geri gönderene de takılmaz (yoksa eski adlı biri başka bir ayarını
kaydedemezdi), rövanş da eski başlığı ve cezayı olduğu gibi kopyalar.

Adlar için filtrenin bir istisnası var (`containsBannedName`, `assertCleanName`): engellilik ve
etnik köklü kalıplar kelimenin başına bakar, bu yüzden "Mehmet Topal", "Ayşe Kıroğlu", Zencir,
Irzık gibi gerçek soyadları da takılıyordu; o kanka kendi adıyla kayıt olamıyordu. Bu birkaç soyadı
(Zencirci, Topaloğulları gibi türevleriyle), tam kelime olarak, adlarda ve başlıklarda serbest;
cümle içindeki "topallar", "kiro herif" yine takılır. Kelime ayrı ayrı bakılır, sondaki rakamlar
yalnız bu soru için atılır: yoksa leet katlaması `mehmet_topal35`'i "topales" diye okuyordu, kayıt
formunun kendi örneği (`mustafa_42`) gibi açılan kullanıcı adı geri dönüyordu.

Başlık, ödül ve ceza bir kişiye değil çelınca yazılır; tehdit kalıplarından spor ağzıyla çakışanlar
("Şekeri keseceğim", "Öldürücü 10K haftası", "geberene kadar koş", "Kafanı dağıt yürüyüşü",
"canını yakacak bir antrenman") orada yalnızca birini de anıyorsa sayılır ("seni", "onu",
"kaybedeni"…; `containsBannedTitle`). Şeker ve sigara bırakma katalogdaki iki çelıncın kendisi; o
başlıklar tehdit diye geri çevriliyordu. "öldürürüm", "gebertirim" ve aile, nefret kalıpları her
yerde aynı.

Özel lafın bitmiş cümlesi gerçek adlarla denetlenir; yalnız o serbest soyadları nötr bir kelimeyle
okunur (`maskSparedSurnames`), yoksa "{loser}'a koydum" Veli Topal'a giden her lafı geri çevirirdi.
Önce her temiz ad bütünüyle nötr okunuyordu: gönderen adını "Karını" yapıp "{winner} sikerim"
yazınca alıcıya "Karını sikerim" gidiyordu. Yer tutucu harflere yapışıksa ("{winner}lar",
"{winner}.lar") adın o harflere değen kelimesi, soyadı olsa da, gerçek haliyle okunur.

## Sunucuyu açanın araçları

E-posta yok, şifre sıfırlama bağlantısı da yok: bu bir arkadaş grubu, herkes sunucuyu açanı
tanır. Şifresini unutana yeni şifreyi o verir: `npm run yonet -- sifre ali` (`src/cli/yonet.ts`;
işin kendisi `services/admin.ts`'te). Komut sunucunun kullandığı veritabanı dosyasını ikinci bir
bağlantıyla açar. WAL ikinci bağlantıyı içeri alır, `busy_timeout` sunucunun yazmasını bekler;
yani sunucu açıkken çalışır. Yeni şifre o hesabın bütün açık oturumlarını kapatır (bkz.
Oturumlar); kanka yeni şifreyle bir daha girer. Şikayetler de aynı yoldan okunur (`sikayetler`): uygulamada onları okuyan bir ekran yok,
sunucu her yeni şikayette kendi penceresine bir `warn` satırı düşer.

README sahibe o pencereyi izlemesini söylüyor, ama şikayetin bir sınırı yoktu: tek bir hesap
2,4 saniyede 3.000 şikayet yazdı, tünel adresi de gerçek hatalar da ekrandan kaydı. `listReports`
da hepsini döküyordu. Şimdi bir hesap saatte en çok 10 şikayet kaydeder (`REPORTS_PER_USER`,
`routes/users.ts`; sayaç giriş sayaçları gibi süreçte durur). Aynı hesap aynı kişiyi 24 saat içinde
aynı sebeple yeniden şikayet ederse (iki kez dokunmak, yeniden denemek) 201 alır, ama ne satır ne
log yazılır, sayaç da işlemez: sahibin okuyacağı yeni bir şey yok, telefon yine "alındı" der. Yeni
bir sebep ("şimdi de tehdit etti") her şikayet gibi kaydedilir; önce o da sessizce atılıyordu,
telefon "alındı" derken sahibe hiç ulaşmıyordu. Seli saatte 10 sınırı zaten durduruyor. `sikayetler` en yeni 200 şikayeti (`REPORTS_LISTED`)
gösterir, fazlası varsa toplamı söyler.

Sebep de sahibin konsolunda okunur. `ESC[2J` ekranı silip listeyi boşaltıyordu, `ESC[8m`
arkasındakini gizliyordu. Sunucu penceresi bunları zaten boşluğa çeviriyordu (`src/log.ts`),
`yonet` ise olduğu gibi basıyordu. Artık `ReportBodySchema` kaçış dizilerini bütünüyle
(`stripEscapeSequences`, `packages/shared/src/text.ts`), görünmez karakterleri ve satır sonlarını
kayıttan önce atar. `yonet` basarken aynısını bir daha yapar, önceden kaydedilmiş sebepler için.
Migration gerekmedi.

Kökteki `npm run yonet` işi sunucu paketinin aynı adlı betiğine `npm run --silent` ile verir.
Komut bir şeyi yapamayınca nedenini `✗` ile başlayan Türkçe bir satırda yazar ve 1 ile çıkar; npm
de bunun altına kendi İngilizce bloğunu basıyordu (``npm error Lifecycle script `yonet` failed``,
`command failed`…). Sahibin ekranında kırmızı bir çökme gibi duruyordu, oysa çoğu zaman yanlış
yazılmış bir kullanıcı adıydı, o kadar. `--silent` yalnızca npm'in kendi satırlarını susturur:
komutun yazdıkları da çıkış kodu da aynı kalır, onu çağıran bir betik hatayı yine anlar.

Şikayetin cevabı da burada: davet bağlantısı WhatsApp gruplarında elden ele geçer; tanımadığı biri
kaydolduysa sunucuyu açan onun hesabını `npm run yonet -- sil <kullanici>` ile kapatır. İş
uygulamadaki "Hesabı sil"in kendisidir (`softDeleteUser`, `services/accounts.ts`): satır silinmez,
adı "Silinen kanka" olur, `authenticate` silinmiş satıra hemen 401 verir. Geri alınamadığı için
komut önce adını sorar; cevap verecek bir terminal yoksa `--evet` olmadan hiçbir şey yapmaz.
Soruya "hayır" demek ise hata değil, sahibin cevabı: hesaba dokunmadığını söyler ve 0 ile çıkar.

Silinen hesabın kanıt fotoğrafları ve notları da gider. Eskiden "Hesabı sil" her şeyin gideceğini
söylüyordu, oysa fotoğraflar diskte duruyor, adresini bilen herkese açılıyordu. Şimdi kullanıcının
girişlerinde `note` ve `proof_url` boşalır; değer ve durum kalır ki biten bir çelıncın sonucu
herkese söylenenle aynı kalsın. Dosyalar commit'ten sonra silinir; yalnızca adı sunucunun verdiği
türdense (`<uuid>.jpg|png|webp`) ve başka hiçbir giriş o adresi göstermiyorsa: API kanıt olarak
her adresi kabul eder, aynı adres başkasının girişinde de olabilir. Diskte olmayan dosya atlanır.
Sonucu henüz çıkmamış bir çelınctaki (bitişten sonraki saat, süren itiraz) girişlere o an
dokunulmaz, çünkü kullanıcı o çelıncta kalır ve bir itirazın cevabı o fotoğraf olabilir. Onları
zamanlayıcı alır: her turda `clearDeletedTraces` silinmiş hesapların, artık bekleyen bir çelıncta
olmayan girişlerindeki notu ve fotoğrafı aynı kuralla siler. Kural tek yerde (`takeTraces`), hem
"Hesabı sil" hem bu tur onu kullanır. Bu, güncellemeden önce silinmiş hesapların kalanlarını da
ilk turda temizler; o zamanki "Hesabı sil" onlara hiç dokunmuyordu. Silinmiş hesabın token'ı
ayrı bir 401 mesajı alır ("Bu hesap kapatıldı…"): ona "tekrar giriş yap" demek boşa umut olurdu. Telefonlarda
önbelleğe girmiş bir kopya (fotoğraflar bir yıl önbellekte durur) sunucudan silinemez.

Hesap silinmeden de diskte sahipsiz fotoğraf birikir. Uygulama fotoğrafı seçildiği an yükler, giriş
daha yokken: kanka vazgeçip başkasını seçerse, günü yeni bir fotoğrafla yeniden gönderirse,
itirazla yanan elle yazılmış bir günü telefonun sayısı geri alırsa (`proof_url` boşalır; telefonun
sadece üstüne yazdığı gün fotoğrafını tutar) ya da girişi silerse dosya kalır. Her biri 1,5-2,5
MB; fotoğraflı birkaç spor çelıncı, sunucuyu açanın dizüstünde kimsenin bilmediği yüzlerce MB
bırakıyordu, `scrubUploadDir` de her açılışta hepsine bakıyordu. Şimdi zamanlayıcı her günün ilk
turunda (açılıştaki de sayılır) `sweepOrphanPhotos`'u çalıştırır (`services/photos.ts`). O, adı
sunucunun verdiği türden (`<uuid>.jpg|png|webp`), hiçbir girişin göstermediği (aynı `…/uploads/<ad>`
kuralıyla, göreli ya da başında sunucu adresiyle) ve 7 günden eski dosyaları siler. Bir hafta,
telefonda sıraya girmiş bir giriş için: kuyruk fotoğrafı yükleyip dönen adresi saklar, giriş günler
sonra gidebilir; bir itirazın cevabı da gönderilmeden önce yüklenir. Kilitli bir dosya (Windows'ta
açık bir fotoğraf görüntüleyici) atlanır, ertesi gün yine denenir. Bellekteki bir veritabanında tur
hiç çalışmaz: önceki açılışların yüklediklerinden habersizdir, klasördeki her dosya ona sahipsiz
görünür. Hiçbir giriş tek bir fotoğraf bile göstermiyorsa da hiçbir şey silinmez: bu, yeni
bilgisayara kopyalanmış `data\uploads` ile henüz geri yüklenmemiş boş bir veritabanıdır, sahipsiz
fotoğraflarla dolu bir klasör değil. Geri yüklemenin kenara koyduğu `koydum-onceki-*.db` dosyalarının girişleri de sayılır
(salt okunur açılır): yanlış yedek seçilince ilk açılış eski yedeğe göre süpürüyor, o yedekten sonra
yazılmış girişlerin bir haftadan eski fotoğraflarını siliyordu, `data/uploads` da hiçbir yedekte
yoktu; kenardaki dosyayı geri koymak girişleri getiriyor, fotoğraflarını getiremiyordu. O dosyalar
durdukça fotoğrafları da durur; açılamayan biri olursa o gün hiçbir şey silinmez.

Bilgisayarı uyanık tutmak da onun işi olurdu, ama akla gelmez: dizüstü 15-30 dakika boşta kalınca
uyur ve uyuyan sunucuya kimse bağlanamaz. Bu yüzden sunucu Windows'ta açılırken gizli bir
PowerShell başlatır (`src/keepAwake.ts`). O, `SetThreadExecutionState` ile sistemin uyumamasını
ister (ekranın değil, ekran yine kararır) ve sunucunun pid'i yaşadıkça bekler; sunucu sertçe
öldürülse de kendi kapanır. Yeni bir bağımlılık gerekmez: o çağrıyı ancak native kod yapabilir,
PowerShell de her Windows'ta var. `KEEP_AWAKE=0` kapatır. Kapak kapanınca bilgisayar yine uyur;
README bunun ayarını anlatır.

O pencereyi okuyan da yalnız o. Bir kanka "bildirim gelmedi" deyince neyin ne zaman olduğunu
orada arar, bu yüzden pino'nun JSON'u bir konsola yazılırken `src/log.ts`'ten geçer: her kayıt
İstanbul saatiyle başlayan tek bir Türkçe satır olur (`21:03:42 • zamanlayıcı: 1 çelınc bitti`),
gün dönünce araya tarih girer, hatanın altına stack trace'in ilk üç satırı gelir (çökmede
hepsi). Çıktı konsola değil de dosyaya, Docker'a ya da bir teste gidiyorsa JSON olduğu gibi
kalır; `LOG_FORMAT=json` konsolda da JSON'da tutar. Satıra giren kullanıcı metni (şikayet
sebebi, hata mesajı) kontrol karakterlerinden arındırılır: bir kaçış dizisi sahibin penceresini
silemez, bir satır sonu sahte bir kayıt uyduramaz.

Yedek de onun işi (`services/backup.ts`). Zamanlayıcı her gün `db.backup()` ile
`data/backups`'a bir kopya yazar. O klasör veritabanıyla aynı diskte durduğu için `BACKUP_DIR`
(OneDrive klasörü gibi) verilmişse aynı dosyalar oraya da kopyalanır. Bu kopya turdan ayrı
koşar: buluttaki ya da ağdaki bir klasör takılırsa çelınc bitirme ve hatırlatmalar beklemez,
hata da sadece bir uyarı satırıdır ve saatte bir yeniden denenir. `BACKUP_DIR`'da da son 7 gün
kalır, oradaki daha eski `koydum-YYYY-AA-GG.db` dosyaları silinir. `yonet -- geri-yukle` sunucu
açıkken çalışmaz: önce `/health`'e sorar, sonra canlı dosyayı bir an açıp kapatır ve `-wal`'ının
hâlâ durup durmadığına bakar (SQLite WAL dosyasını son bağlantı kapanırken siler; duruyorsa dosyayı
başka biri tutuyordur). Yedeği veritabanının yanına kopyalayıp orada sınar, eskisini
`koydum-onceki-*.db` diye kenara koyar; hiçbir şey silinmez.

`users` tablosu boşken yedek alınmaz. Bilgisayarı ölen sahip yenisinde çoğu zaman önce sunucuyu
boş klasörle açar, ancak sonra `geri-yukle`'yi hatırlar. O boş veritabanının kopyası
`geri-yukle`'nin seçtiği en yeni gün olurdu, bir hafta açık kalınca da gerçek yedekleri
`BACKUP_DIR`'dan budardı. Eski sürümlerin yazdığı boş kopyalar için `geri-yukle` yüklediği
dosyadaki açık hesapları da sayar (yine veritabanının yanındaki kopyada, OneDrive'daki dosya hiç
açılmaz) ve sıfırsa "sunucuyu aç" yerine başka bir gün seçmesini söyler. Aynı günün öbür
klasörde de bir dosyası varsa (BACKUP_DIR'ın o günden kalan gerçek kopyası) önce onu, tam yoluyla,
önerir: günü ya da adı yazılınca `findBackup` yine yerel kopyayı bulur.
