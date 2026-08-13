# VPN Client — tarayıcı eklentisi (companion)

## Ne yapar, ne yapamaz

**Yapamaz: tünel kuramaz.** Bir tarayıcı eklentisi işletim sistemi seviyesinde
VPN tüneli açamaz — `chrome.vpnProvider` API'si sadece ChromeOS'ta var.

**Yapar:** bilgisayardaki VPN servisine (`vpnd`) sunucu adresini ve davet
kodunu iletir, o da bu makineyi kaydedip tüneli açar. Rozette anlık durum,
popup'ta tek tuşla bağlan/kes, `Ctrl+Shift+U` ile klavyeden.

**Anahtar eklentide durmaz.** Popup'a girilen iki şey doğrudan `vpnd`'ye
gider; WireGuard anahtar çiftini `vpnd` üretir ve kendinde tutar. Bu boru
hattından hiçbir yönde anahtar geçmez — native host'un izin listesinde `up`
metodunun bulunmamasının sebebi de bu. Eklenti kaydedilirse
`chrome.storage.local` düz metindir ve tarayıcı profiline erişen her şey
okuyabilir; oraya private key koymak istemiyoruz.

Kod bir kez kullanılır: makine kendi cihaz token'ını alır ve saklar, yani
yeniden başlatmadan sonra da eklenti tek başına bağlanır.

**Ve tünelin kapatamadığı deliği kapatır.** Asıl gerekçesi bu:

| Ayar | Ne yapıyor |
|---|---|
| **WebRTC** (varsayılan: açık) | WebRTC, sayfa JavaScript'ine ağ adaptörlerini doğrudan sorar; tünel açıkken bile gerçek adresini sızdırabilir. Masaüstü uygulaması bunu engelleyemez, sadece tarayıcı engelleyebilir. `Açık` yerel adresleri gizler ve görüşmeleri bozmaz; `Katı` proxy'lenmemiş UDP'yi tamamen reddeder (görüntülü görüşmeler çalışmayabilir). |
| **Kill switch** (varsayılan: kapalı) | Tünel düştüğünde tarayıcı isteklerini keser. |
| **Açılışta bağlan** (varsayılan: kapalı) | Tarayıcı açılınca son bağlantıyı yeniden kurar. |

Kill switch **daemon'a ulaşılamadığında engellemez.** Bu bilinçli: rozetin
`?` göstermesiyle aynı ilke — bilinmeyen, "kapalı" değildir. Ulaşılamadığında
engellemek, tarayıcıyı internetten tamamen koparır ve durumu açıklayacak
sayfa da dahil her şeyi kapatır. Popup her hâlükârda çalışır; eklenti
sayfaları bu kurallara tabi değil.

### Reklam ve izleyici engelleme

Varsayılan olarak **açık**. 77 alan adı, iki ayrı listede:

- `rules/ads.json` — reklam ağları (doubleclick, criteo, taboola, adnxs…)
- `rules/trackers.json` — analitik (google-analytics, hotjar, mixpanel…),
  atıf SDK'ları (appsflyer, adjust, branch) ve sosyal işaretçiler
  (connect.facebook.net, analytics.tiktok.com…)

Üç tasarım kararı:

**Listeler eklentinin içinde geliyor, uzaktan çekilmiyor.** Uzaktan çekmek host
izni ve ağ çağrısı isterdi — yani bu eklentinin üzerine kurulu olduğu özelliği
yok ederdi.

**Hepsi `thirdParty`.** Bir sitenin kendi alan adından gelen kaynaklar
engellenmiyor; sadece üçüncü taraf istekleri. Analitiğini kendi alan adı
altında barındıran siteler bozulmuyor.

**Sosyal listede ana alan adları yok.** `connect.facebook.net` engelleniyor ama
`facebook.com` engellenmiyor — hedef, tıklanmasa bile göründüğü her sayfayı
raporlayan işaretçiler, sitelerin kendisi değil.

**Site bazlı izin:** popup'ta bulunduğun sitenin adıyla bir satır çıkıyor —
"Allow example.com". Reklam çağrısı başarısız olunca bozulan siteler için
engellemeyi her yerde kapatmak yerine tek siteyi muaf tutuyorsun. Kural
`initiatorDomains` ile yazılıyor: o sitenin *yaptığı* isteklere izin veriyor.

Siteyi öğrenmek için `activeTab` kullanılıyor — sadece araç çubuğu simgesine
tıklandığında ve sadece o sekme için veriliyor. `tabs` ya da host izni aynı
bir satırlık metin için tüm sekmeleri kalıcı olarak açardı.

Öncelikler bilerek şöyle: **kill switch (30) > izin listesi (20) > engelleme
(1)**. "Burada reklam engelleme" bir sitenin kill switch'i delmesine yol
açmamalı — tünel düşükken izin verilen sitede gezinebilmek, kill switch'in
tam tersi olurdu.

Bu liste kısa ve seçilmiş; EasyList'ten dönüştürülmüş değil. **uBlock Origin'in
yerini tutmaz**, makul bir varsayılandır. Kapsamı büyütmek istersen tek makul
kaynak EasyList/EasyPrivacy (CC BY-SA 3.0, NonCommercial kaydı yok).
DuckDuckGo Tracker Radar **verisi** CC BY-NC-SA 4.0 — kişisel kullanımda
sorun değil ama AGPL bir depoya gömülmesi çelişki yaratır, çünkü AGPL ticari
kullanıma izin vermek zorunda.

Sınırlar bol: 4 statik kural / 30.000 garantili, 2 etkin ruleset / 50.

---

Bu ayarların hiçbiri **ağ izni istemiyor**: `privacy` yalnızca bir tarayıcı
tercihini yazıyor, `declarativeNetRequest`'in engelleme kuralları host izni
gerektirmiyor — kuralları tarayıcı uyguluyor ve sonucu eklentiye hiç
bildirmiyor. Eklenti hâlâ hiçbir sayfayı okuyamıyor, hiçbir isteği göremiyor.

```
Eklenti (popup + service worker)
    │  native messaging (4 bayt uzunluk + JSON, stdio)
    ▼
vpn-browser-host          ← sadece 3 eyleme izin verir: status/connect/disconnect
    │  AF_UNIX soket
    ▼
vpnd (ayrıcalıklı servis)
```

Köprü **`up` metodunu dışarı açmaz.** `up` içinde private key olan bir config
alır; eklentinin böyle bir şeyi tutmasının hiçbir gerekçesi yok. "Connect",
daemon'un o oturumda zaten kabul ettiği config'i yeniden uygular
(`reconnect`) — hiç bağlanılmamışsa "uygulamayı aç" der.

Erişim kontrolü `allowed_origins`: host manifest'inde listelenen eklenti ID'si
dışında hiçbir şey bu köprüyü başlatamaz.

## Kurulum (geliştirme)

**1. Köprüyü derle**

```bash
cd vpnd
go build -o bin/vpn-browser-host ./cmd/vpn-browser-host
```

**2. Eklentiyi yükle**

Chrome → `chrome://extensions` → Developer mode → "Load unpacked" → `extension/`
Yüklendikten sonra Chrome'un verdiği **eklenti ID'sini** kopyala.

**3. Host manifest'ini yaz**

`extension/native-host/com.example.vpn_client.json` içindeki iki
`REPLACE_WITH_...` alanını doldur, sonra platforma göre yerleştir:

| Platform | Konum |
|---|---|
| Windows | Kayıt defteri anahtarı (aşağıda) |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/` |

Windows'ta manifest'in yolu kayıt defterinde gösterilir:

```powershell
$manifest = "C:\dev\Vpn\extension\native-host\com.example.vpn_client.json"
New-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.example.vpn_client" -Force |
  Set-ItemProperty -Name '(Default)' -Value $manifest
```

**4. Chrome'u tamamen kapatıp aç.** Native messaging host'ları başlangıçta
okunur; yeniden başlatmadan görünmez.

## Doğrulama

Köprüyü elle test etmek için (Chrome olmadan): mesaj çerçevesi 4 baytlık
little-endian uzunluk + JSON.

```bash
printf '\x13\x00\x00\x00{"action":"status"}' | ./bin/vpn-browser-host
```

Servis çalışmıyorsa `{"ok":false,"error":"The VPN service is not running."}`
döner — çökmez.

## Firefox

Firefox de aynı native messaging protokolünü kullanıyor ama manifest'te
`allowed_origins` yerine `allowed_extensions` (eklenti ID'si değil, add-on ID'si)
istiyor ve MV3 service worker yerine `background.scripts` bekliyor. Ayrı bir
manifest gerekiyor; henüz yazılmadı.

## Bilinen sınırlar

- **Rozet anlık değil.** MV3 service worker'ı tarayıcı istediği zaman
  öldürüyor, o yüzden durum bir alarm ile dakikada bir yenileniyor. Popup
  açıldığında her zaman taze durum çekiliyor.
- **Durum bilinmiyorsa rozet boş/`?`** — "kapalı" yazmıyor. Korumasızken
  "kapalı" demek doğru olurdu ama bilinmezken "kapalı" demek yanıltıcı olur.
- **Site bazlı kural yok.** Tünel tüm cihazı kapsıyor; tarayıcı bazında istisna
  ancak proxy tabanlı ayrı bir üründe anlamlı olur.
