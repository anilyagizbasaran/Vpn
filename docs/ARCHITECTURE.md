# Mimari

Bu dosya sistemin **neden** böyle kurulduğunu anlatır. Nasıl kurulacağı
[GO-LIVE.md](GO-LIVE.md)'de, ayar ve sorun giderme [TUNING.md](TUNING.md)'de.

## Temel ilke

Hiçbir bileşenin ele geçirilmesi tek başına yeterli olmasın.

| Bileşen | Ne biliyor | Ne bilmiyor |
|---|---|---|
| Control plane (`server/`) | E-posta, parola hash'i, **açık anahtarlar** | Özel anahtarları; WireGuard'a hiç dokunmaz |
| Node ajanı (`vpn-node-agent`) | Interface'i değiştirebilir | Hesabı, token'ı, kullanıcıları |
| İstemci (`apps/client`) | Hesap kimliği, **özel anahtar** | Ağ arayüzüne dokunamaz (masaüstünde) |
| Masaüstü servisi (`vpnd`) | Yerel tüneli kurar | Hesabı — API'ye hiç çıkmaz |
| Eklenti (`extension/`) | Tünel açık mı kapalı mı | Config göremez, üretemez |

Sonuçları:

- Sunucu diski ele geçse trafiği kimse çözemez; özel anahtarlar orada yok.
- Control plane ele geçse hiçbir node'da komut çalıştırılamaz; dışarı aramıyor.
- Bir node ele geçse hesaplar alınamaz; node token'ı sadece kendi peer setini
  görüyor.
- `vpnd` ele geçse hesap alınamaz, GUI ele geçse root olunamaz.

Bedeli açık: **özel anahtar kaybolursa cihaz kurtarılamaz.** Sunucuda kopyası
yok. Uygulama bunu cihazı silip yenisini kaydederek çözüyor.

## İki düzlem

```
KONTROL DÜZLEMİ                          VERİ DÜZLEMİ
───────────────                          ────────────
İstemci ──HTTPS──> Caddy ──> Node        İstemci ──UDP 51820──> WireGuard
          :443            :3000                                  (wg0)
                            │                                      ▲
                         SQLite                                    │
                            ▲                              vpn-node-agent
                            └──── POST /node/sync ──────────────────┘
                                  (ajan çeker, 10sn)
```

Trafik API'ye hiç uğramaz. Control plane çökerse mevcut tüneller çalışmaya
devam eder — ajan son gördüğü peer setini koruyor.

## Katmanlar

Tek kural: **üst katman alt katmanı bilir, alt katman üstü asla bilmez.**

```
L4  apps/client   apps/dashboard   extension/       ← birbirini tanımaz
    ────────────────────────────────────────────
L3  vpn_client    oturum · cihaz kimliği · rotasyon · bölge seçimi
L2  vpn_tunnel    tünel sözleşmesi (saf Dart)
      ├─ vpn_tunnel_mobile    wireguard_flutter_plus
      └─ vpn_tunnel_desktop   vpnd IPC istemcisi
L1  vpn_api       HTTP + modeller      (Flutter yok, dart:io yok)
L0  vpn_crypto    X25519               (bağımlılıksız)
```

Üç sınır bilerek çizildi:

1. **`SessionStore` / `DeviceStore`** — `vpn_api` Flutter'sız ve `dart:io`suz
   kalsın diye. Karşılığı somut: `apps/dashboard` aynı API istemcisini web'de
   derliyor, ve CI her push'ta o build'i çalıştırarak sınırı koruyor. Ayrıca
   cihaz özel anahtarı mimari olarak API katmanının erişemeyeceği yerde.
2. **`TunnelStage`** — plugin'in enum'u yerine kendi sözlüğümüz. Masaüstünde
   plugin yerine daemon istemcisi koymak **tek paketi** etkiledi.
3. **`ApiClient` transport hatalarını `dart:io` olmadan yakalıyor** — web'de
   derlenebilmesi için zorunluydu; yan etkisi olarak TLS hatalarını da
   kapsıyor, ki eskiden kaçırıyorduk.

## Veri modeli

```
users
 └─ devices        tek keypair · kotanın saydığı şey · kullanıcının gördüğü şey
      └─ peers     cihazı bir sunucuya bağlayan adres tahsisi
           └─ peer_usage
servers (nodes)    agent_token_hash · status · last_seen_at · reported_public_key
```

**Neden `devices` ve `peers` ayrı:** başta peer'ın kendisi cihazdı. İkinci
sunucuda bu kırılıyor — bir cihazın ulaşabildiği her sunucuda adresi olması
gerekiyor ve bunları beş cihaz limitine saymak, üç bölgenin tek telefonla
kotayı tüketmesi demek olurdu.

**Neden tek anahtar, çok sunucu:** WireGuard (istemci, sunucu) çifti bazında
doğruluyor, aynı istemci anahtarının birden çok sunucuyla eşleşmesi normal.
Bölge değiştirmeyi bir round trip değil, config'de tek satır yapan şey bu.
Mullvad'ın modeli.

> Çoklu sunucu şu an kullanılmıyor. Şema, node protokolü ve istemcideki bölge
> seçimi hazır; ikinci node eklemek `npm run node:add` ve bir ajan kurulumu.

## Uçtan uca akış

```
1. KAYIT       POST /auth/register → access (JWT 15dk) + refresh (opaque 30g)

2. CİHAZ       İstemci X25519 çifti üretir; özel anahtar secure storage'a
               POST /devices {publicKey, platform}
               Control plane: kota → her aktif node'da havuzdan adres → DB
               ← .conf, ama PrivateKey = <PRIVATE_KEY>

3. YAYILMA     Ajan POST /node/sync ile peer setini çeker (≤10sn)
               Tek bir `wg set` çağrısıyla uygular

4. TÜNEL       İstemci placeholder'ı kendi anahtarıyla değiştirir
               mobil:     doğrudan VpnService / NetworkExtension
               masaüstü:  AF_UNIX soketi üzerinden vpnd'ye verir

5. ROTASYON    Anahtar 7 günden eskiyse POST /devices/:id/rotate
               Cihaz id'si, etiketi ve **tüm adresleri** aynı kalır
```

## Neden bu kararlar

**Control plane WireGuard'a hiç dokunmuyor.** Anahtarları istemci üretiyor,
PSK 32 rastgele bayt, peer'ları ajanlar uyguluyor. Geriye `wg`'ye ihtiyaç
duyan hiçbir şey kalmadı — API ayrıcalıksız, container'da, WireGuard kurulu
olmayan bir makinede çalışabiliyor.

**Node'lar çeker, control plane hiç dışarı aramaz.** Push modeli control
plane'de her node'un root'unu veren bir kimlik gerektirirdi ve her node'un
oradan erişilebilir olmasını isterdi. Çekme modelinde node WireGuard portu
dışında hiçbir şey açmıyor.

**Bunun bedeli:** iptal **anında değil**, bir poll aralığında yayılıyor
(`NODE_POLL_SECONDS`, varsayılan 10sn). Bilinçli takas.

**Ajan durum tutmuyor.** Control plane ne cevaplarsa doğru odur; bir saat
offline kalan node ilk başarılı sync'te kendine geliyor. Reboot için ayrı bir
kurtarma yolu yok — aynı yol.

**Sync başarısız olursa ajan peer tablosuna dokunmuyor.** Control plane
kesintisini tam kesintiye çevirmek yanlış yön.

**İstemci açık anahtarını da saklıyor.** Bağlanırken sunucununkiyle
karşılaştırıyor; uyuşmazsa (yarıda kalmış rotasyon, yedekten geri yükleme)
anahtarı yeniliyor — yoksa tünel sonsuza kadar "connecting"de kalır ve hiçbir
yerde hata görünmez.

**Masaüstünde ayrıcalıklı daemon.** GUI'yi yükseltilmiş çalıştırmak Flutter'ın
tüm saldırı yüzeyini root'a taşır. Mullvad ve Tailscale aynı şekilde bölüyor.

**`vpnd` config'i allowlist'liyor.** wg-quick `PostUp` satırlarını root olarak
çalıştırıyor ve sokete ayrıcalıksız bir süreç ulaşabiliyor; anahtar allowlist'i
olmasa yerel herhangi bir kullanıcı root shell alırdı. Blocklist değil
allowlist: wg-quick'e ileride eklenecek ve bir şey çalıştıran bir anahtar
varsayılan olarak reddedilsin.

**Soket AF_UNIX, loopback TCP değil.** Localhost TCP'ye makinedeki her süreç
ulaşır, ACL uygulanamaz ve tarayıcıdan POST atılabilir — Tailscale'in Windows
istemcisi tam bu yüzden zafiyet aldı. Dart'ın Windows'ta AF_UNIX desteklediğini
ölçtük (`packages/vpn_tunnel/tool/af_unix_probe.dart`), varsaymadık.

**Eklenti config gönderemez.** Köprü tam üç eyleme izin veriyor: status,
connect, disconnect. "Connect", daemon'un o oturumda zaten kabul ettiği
config'i yeniden uyguluyor.

**Bilinmeyen durum "kapalı" değildir.** Eklenti rozeti daemon'a ulaşamazsa `?`
gösteriyor, node'un liveness'ı bilinmiyorsa `online: false`. Korumasızken
"kapalı" demek doğru; bilinmezken "kapalı" demek yanıltıcı.

## Test stratejisi

Gerçek yolları test ediyoruz, mock'lanmış kopyaları değil:

| Ne | Nasıl |
|---|---|
| `wg` CLI (ajan) | `Runner` enjeksiyonu — tam argv doğrulanıyor |
| `flutter_secure_storage` | Platform kanalı mock'lanıyor, gerçek `SecureStore` çalışıyor |
| vpnd IPC | Dart tarafında gerçek AF_UNIX soketi üzerinden sahte daemon |
| Node protokolü | Gerçek HTTP, iki node ile izolasyon ve eş zamanlı tahsis |
| Anahtar türetme | **RFC 7748 §6.1 test vektörleri** — kendi kendine tutarlılık değil |
| Native messaging | Gerçek çerçeveleme ile stdio round-trip |

Anahtar türetme neden vektörlere sabitlendi: yanlış türetmede tünel hiçbir hata
vermeden asla handshake yapmaz. Kendi kendini doğrulayan bir test bunu kaçırır.

`acceptance.mjs --check-wg` mock'un asla yakalayamayacağı tek şeyi yakalıyor:
cihaz oluşturup anahtarın `wg show`'da **belirmesini bekliyor**, yani API →
veritabanı → ajan → `wg` zincirinin tamamını sınıyor.

## Bilerek yapılmayanlar

1. **Kod imzalama** — para ve evrak işi. Windows OV sertifikası ~$200-400/yıl,
   Apple Developer $99/yıl + notarization.
2. **E-posta doğrulama** — SMTP sağlayıcı seçimi ürün kararı. Yarım bir akış
   hiç olmamasından kötü.
3. **Ödeme/abonelik** — kayıt olan herkes 5 cihaz alıyor.
4. **iOS Network Extension** — entitlement başvurusu gerekiyor, haftalar sürer.
5. **Masaüstünde kill switch** — daemon firewall kurallarını yazabilir ama
   yazmıyor. Android'de OS'un yerleşiği kullanılıyor.
6. **Bölge seçici UI** — `VpnController.selectServer()` hazır, ekranda düğmesi
   yok. Çoklu sunucu kullanılmaya başlanınca eklenecek.
