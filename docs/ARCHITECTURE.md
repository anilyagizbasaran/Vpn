# Mimari

Bu dosya sistemin **neden** böyle kurulduğunu anlatır. Nasıl kurulacağı
[README](../README.md)'de.

## Temel ilke

Hiçbir bileşenin ele geçirilmesi tek başına yeterli olmasın.

| Bileşen | Ne biliyor | Ne bilmiyor |
|---|---|---|
| Control plane (`server/`) | E-posta, parola hash'i, **açık anahtarlar** | Özel anahtarları, trafiğin içeriğini |
| Uygulama (`apps/client`) | Hesap kimliği, **özel anahtar** | Ağ arayüzüne dokunamaz |
| Daemon (`vpnd/`) | Ağ arayüzünü değiştirebilir | Hesabı, token'ı — API'ye hiç çıkmaz |
| Eklenti (`extension/`) | Tünel açık mı kapalı mı | Config göremez, üretemez |

Sonuçları:

- Sunucu diski ele geçse trafiği kimse çözemez; özel anahtarlar orada yok.
- vpnd ele geçse hesap alınamaz; API'ye hiç çıkmıyor.
- Uygulama ele geçse root olunamaz; arayüz ayrıcalıksız çalışıyor.
- Eklenti ele geçse config alınamaz; köprü `up` metodunu dışarı açmıyor.

Bedeli açık: **özel anahtar kaybolursa peer kurtarılamaz.** Sunucuda kopyası
yok. Uygulama bunu cihazı silip yenisini kaydederek çözüyor.

## İki düzlem

```
KONTROL DÜZLEMİ                          VERİ DÜZLEMİ
───────────────                          ────────────
İstemci ──HTTPS──> Caddy ──> Node        İstemci ──UDP 51820──> WireGuard
          :443            :3000                                  (wg0)
                            │
                         SQLite
```

Trafik API'ye hiç uğramaz. Node çökerse mevcut tüneller çalışmaya devam eder;
sadece yeni cihaz eklenemez.

## Katmanlar

Tek kural: **üst katman alt katmanı bilir, alt katman üstü asla bilmez.**

```
L4  apps/client   apps/dashboard   extension/       ← birbirini tanımaz
    ────────────────────────────────────────────
L3  vpn_client    oturum · cihaz kimliği · rotasyon politikası
L2  vpn_tunnel    tünel sözleşmesi (saf Dart)
      ├─ vpn_tunnel_mobile    wireguard_flutter_plus
      └─ vpn_tunnel_desktop   vpnd IPC istemcisi
L1  vpn_api       HTTP + modeller      (Flutter yok, dart:io yok)
L0  vpn_crypto    X25519               (bağımlılıksız)
```

Üç sınır bilerek çizildi:

1. **`SessionStore` / `DeviceStore`** — `vpn_api` Flutter'sız ve `dart:io`suz
   kalsın diye. Karşılığı somut: `apps/dashboard` aynı API istemcisini web'de
   derliyor. Ayrıca cihaz özel anahtarı mimari olarak API katmanının
   erişemeyeceği yerde — oturum temizliği sunucunun yeniden üretemeyeceği bir
   kimliği yanlışlıkla silemez.
2. **`TunnelStage`** — plugin'in enum'u yerine kendi sözlüğümüz. Masaüstünde
   plugin yerine daemon istemcisi koymak **tek paketi** etkiledi.
3. **`ApiClient` transport hatalarını `dart:io` olmadan yakalıyor** — web'de
   derlenebilmesi için zorunluydu; yan etkisi olarak TLS hatalarını da
   kapsıyor, ki eskiden kaçırıyorduk.

CI'da dashboard'un web build'i bu sınırların bekçisi: birisi `vpn_api`'ye
Flutter eklerse build kırılır.

## Uçtan uca akış

```
1. KAYIT       POST /auth/register → access (JWT 15dk) + refresh (opaque 30g)

2. CİHAZ       İstemci X25519 çifti üretir; özel anahtar secure storage'a
               POST /peers {publicKey, platform}
               Sunucu: kota (5) → havuzdan en düşük boş IP → DB satırı
                       → wg set wg0 peer <pub> allowed-ips 10.8.0.2/32
               ← .conf, ama PrivateKey = <PRIVATE_KEY>

3. TÜNEL       İstemci placeholder'ı kendi anahtarıyla değiştirir
               mobil:     doğrudan VpnService / NetworkExtension
               masaüstü:  AF_UNIX soketi üzerinden vpnd'ye verir

4. ROTASYON    Anahtar 7 günden eskiyse POST /peers/:id/rotate
               Tek `wg set` çağrısında eski düşer, yeni girer
               Cihaz id'si, etiketi, IP'si değişmez; kota yemez
```

## Neden bu kararlar

**Sunucu tarafında DB kaynak doğrusudur.** `wg set` state'i reboot'ta kaybolur.
Açılışta `syncInterface()` DB'deki aktif peer'ları tek çağrıyla yeniden uygular.
Peer eklerken önce DB (adres rezervasyonu), sonra `wg`; silerken tersi. Ters
sıra iptal edilmiş bir anahtarı geri diriltebilirdi.

**İstemci açık anahtarını da saklar.** Bağlanırken sunucununkiyle karşılaştırır.
Uyuşmazsa (yarıda kalmış rotasyon, yedekten geri yükleme) anahtarı yeniler —
yoksa tünel sonsuza kadar "connecting"de kalır ve hiçbir yerde hata görünmez.

**Masaüstünde ayrıcalıklı daemon.** GUI'yi yükseltilmiş çalıştırmak Flutter'ın
tüm saldırı yüzeyini root'a taşır. Mullvad, Tailscale ve diğerleri aynı şekilde
bölüyor.

**Daemon config'i allowlist'ler.** wg-quick `PostUp` satırlarını root olarak
çalıştırıyor. Sokete ayrıcalıksız bir süreç ulaşabildiği için, anahtar
allowlist'i olmasa yerel herhangi bir kullanıcı root shell alırdı. Blocklist
değil allowlist: wg-quick'e ileride eklenecek ve bir şey çalıştıran bir anahtar
varsayılan olarak reddedilsin.

**Soket AF_UNIX, loopback TCP değil.** Localhost TCP'ye makinedeki her süreç
ulaşır, ACL uygulanamaz ve tarayıcıdan POST atılabilir — Tailscale'in Windows
istemcisi tam bu yüzden zafiyet aldı. Dart'ın Windows'ta AF_UNIX desteklediğini
ölçtük (`packages/vpn_tunnel/tool/af_unix_probe.dart`), varsaymadık.

**Eklenti config gönderemez.** Köprü tam üç eyleme izin verir: status, connect,
disconnect. "Connect", daemon'un o oturumda zaten kabul ettiği config'i yeniden
uygular; hiç bağlanılmamışsa "uygulamayı aç" der.

**Bilinmeyen durum "kapalı" değildir.** Eklenti rozeti daemon'a ulaşamazsa `?`
gösterir. Korumasızken "kapalı" demek doğru; bilinmezken "kapalı" demek
yanıltıcı.

## Test stratejisi

Gerçek yolları test ediyoruz, mock'lanmış kopyaları değil:

| Ne | Nasıl |
|---|---|
| `wg` CLI | `CommandRunner` enjeksiyonu — tam argv doğrulanıyor |
| `flutter_secure_storage` | Platform kanalı mock'lanıyor, gerçek `SecureStore` çalışıyor |
| vpnd IPC | Dart tarafında gerçek AF_UNIX soketi üzerinden sahte daemon |
| Anahtar türetme | **RFC 7748 §6.1 test vektörleri** — kendi kendine tutarlılık değil |
| Native messaging | Gerçek çerçeveleme ile stdio round-trip |

Anahtar türetme neden vektörlere sabitlendi: yanlış türetmede tünel hiçbir hata
vermeden asla handshake yapmaz. Kendi kendini doğrulayan bir test bunu kaçırır.

## Bilerek yapılmayanlar

1. **Kod imzalama** — para ve evrak işi. Windows OV sertifikası ~$200-400/yıl,
   Apple Developer $99/yıl + notarization. İmzasız yapılar SmartScreen uyarısı
   verir; indirme sayfası bunu gizlemiyor.
2. **E-posta doğrulama** — SMTP sağlayıcı seçimi ürün kararı. Yarım bir akış hiç
   olmamasından kötü.
3. **Ödeme/abonelik** — kayıt olan herkes 5 cihaz alıyor.
4. **iOS Network Extension** — entitlement başvurusu gerekiyor, haftalar sürer.
5. **Masaüstünde kill switch** — daemon firewall kurallarını yazabilir ama
   yazmıyor. Android'de OS'un yerleşiği kullanılıyor.
6. **Çoklu sunucu** — şema hazır (`servers` tablosu + `server_id` FK), seçim
   arayüzü yok.
