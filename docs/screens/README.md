# Ekran görüntüleri

Buradaki PNG'ler elle çekilmez; `node e2e/smoke.mjs` uçtan uca testi çalışırken üretir.
Test gerçek sunucuyu geçici bir veritabanıyla başlatır, iki kullanıcı kaydeder, aralarında
bir çelinç oynatır, sonucu kesinleştirir ve kazananın "KOYDUM MU?" bildirimini gönderir;
ardından web derlemesini Chromium'da açıp her ekranı yakalar.

Yani bu görüntüler sahte veriyle değil, uygulamanın kendi ürettiği veriyle çekilmiştir.

| Dosya | Ne gösteriyor |
|---|---|
| `01-login.png` | Giriş ekranı |
| `02-home-loser.png` | Kaybedenin ana sayfası |
| `03-shame.png` | Rezillik ekranı: gelen KOYDUM |
| `04-winner.png` | Kazananın sonuç ekranı ve "KOYDUM MU?" düğmesi |
| `05-home-winner.png` | Kazananın ana sayfası |
| `06-inbox.png` | Gelen kutusu |
