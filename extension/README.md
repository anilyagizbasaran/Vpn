# VPN Client — tarayıcı eklentisi (companion)

## Ne yapar, ne yapamaz

**Yapamaz: tünel kuramaz.** Bir tarayıcı eklentisi işletim sistemi seviyesinde
VPN tüneli açamaz — `chrome.vpnProvider` API'si sadece ChromeOS'ta var.

**Yapar:** masaüstü uygulamasının kurduğu tünelin durumunu gösterir, açıp
kapatır. Rozette anlık durum, popup'ta tek tuşla bağlan/kes.

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
