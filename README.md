# WireGuard VPN — Control Plane, İstemciler ve Daemon

Kendi VPS'in üzerinde çalışan WireGuard tabanlı VPN servisi.

Üç ayrı güven bölgesi: **control plane** hesapları ve açık anahtarları bilir ama
WireGuard'a hiç dokunmaz; **node ajanı** interface'i değiştirir ama hesabı
bilmez; **istemci** özel anahtarı tutar ama ağa dokunamaz. Hiçbirinin ele
geçirilmesi tek başına yeterli değil.

Çoklu sunucu altyapısı hazır ama tek node ile çalışıyor — bkz.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
Vpn/
├── server/           Control plane — Node + Express + TypeScript (127 test)
│   ├── scripts/      Sunucu kurulum scriptleri (bash, idempotent)
│   └── deploy/       systemd unit + Caddyfile
├── vpnd/             Masaüstü servisi + node ajanı — Go (5 paket test)
│   ├── cmd/          vpnd · vpnctl · vpn-browser-host · vpn-node-agent
│   └── deploy/       systemd unit + Windows kurulum betiği
├── packages/         Paylaşılan Dart katmanları (90 test)
│   ├── vpn_crypto/       L0  X25519 (bağımlılıksız)
│   ├── vpn_api/          L1  HTTP + modeller (Flutter yok, dart:io yok)
│   ├── vpn_tunnel/       L2  tünel sözleşmesi
│   ├── vpn_tunnel_mobile/    L2  Android/iOS
│   ├── vpn_tunnel_desktop/   L2  vpnd IPC istemcisi
│   └── vpn_client/       L3  controller'lar, depolama, rotasyon politikası
├── apps/
│   ├── client/       L4  Flutter uygulaması — Android/iOS/Win/macOS/Linux
│   └── dashboard/    L4  Flutter web — hesap ve cihaz yönetimi
├── extension/        Companion tarayıcı eklentisi (MV3)
├── website/          İndirme sayfası
└── docs/             ARCHITECTURE.md · GO-LIVE.md · TUNING.md
```

- Mimarinin gerekçeleri ve güven modeli: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**
- Canlıya alma sırası ve doğrulama adımları: **[docs/GO-LIVE.md](docs/GO-LIVE.md)**
- Kopmalar, MTU, throughput: **[docs/TUNING.md](docs/TUNING.md)**

## Doğrulama scriptleri

Unit testler kodun doğru olduğunu kanıtlıyor. Bunlar **kurulumun** doğru
olduğunu kanıtlıyor — laptopta çalışıp sunucuda sessizce bozulan şeyleri.

| Script | Nerede çalışır | Ne yakalar |
|---|---|---|
| `server/scripts/verify-deploy.sh` | VPS (root) | Forwarding kapalı, NAT kuralı yok, API root olarak çalışıyor, `.env` placeholder secret, buffer/conntrack ayarları |
| `server/scripts/acceptance.mjs` | Her yerden | Uçtan uca API: rotasyon, reuse detection, izolasyon, kota, `--check-wg` ile "API peer oluşturdum diyor ama interface'te yok" |
| `server/scripts/verify-tunnel.sh` | İstemci (bağlıyken) | **IPv6 sızıntısı**, DNS nereye gidiyor, MTU (ping çalışır HTTPS takılır) |
| `vpnd/scripts/verify-daemon.{sh,ps1}` | Masaüstü | Soket TCP'de mi dinliyor, ACL, protokol uyuşmazlığı, **`PostUp` gerçekten çalışıyor mu** |

```bash
cd server && npm run acceptance -- https://api.senin-domain.com --check-wg
```

Acceptance betiği kendi hesaplarını açıp siler, production'da çalıştırmak
güvenli. Daemon betiği `PostUp` içeren düşman bir config'i gerçekten göndermeyi
dener — çalışsaydı root olarak kod çalıştırılmış olurdu, o yüzden dosya yazıp
yazmadığına bakıyor.

---

## Hızlı başlangıç (geliştirme makinesi, WireGuard gerekmez)

```bash
cd server
npm install
npm test          # 127 test
npm run dev       # http://localhost:3000
```

`.env` zaten `WG_SKIP_BOOTSTRAP_NODE=true` ile hazır: yerelde node tanımlı
değil, `/ready` 503 döner ve cihaz kaydı 422 verir. Node tanımlamak için
`npm run node:add`. Control plane WireGuard'a hiç dokunmadığı için geliştirme
makinesinde `wg` kurulu olması gerekmiyor.

Flutter tarafı (workspace kökünden tek `pub get` hepsini çözer):

```bash
dart pub get
cd apps/client
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000   # Android emulator
```

Masaüstünde ayrıca daemon gerekir:

```bash
cd vpnd
go build -o bin/vpnd ./cmd/vpnd && go build -o bin/vpnctl ./cmd/vpnctl
./bin/vpnd -mock -socket /tmp/vpnd.sock     # gerçek tünel kurmadan dener
```

Web dashboard:

```bash
cd apps/dashboard
flutter run -d chrome --dart-define=API_BASE_URL=http://localhost:3000
```

> **Windows'ta bir kerelik ayar:** workspace path bağımlılıkları Flutter'ın
> symlink oluşturmasını gerektiriyor, o da Developer Mode istiyor —
> `start ms-settings:developers`. Açılmadan `flutter build` çalışmaz.

---

## Faz 1 — Sunucu kurulumu

`server/scripts/setup-wg.sh` idempotenttir: tekrar çalıştırınca anahtarları
yeniden üretmez, mevcut `wg0.conf` dosyasına dokunmaz (`--force` hariç), sysctl /
sudoers / systemd değişikliklerini sadece farklıysa yazar.

```bash
# VPS üzerinde (Ubuntu/Debian, root)
scp -r server/scripts root@vps:/tmp/
ssh root@vps
sed -i 's/\r$//' /tmp/scripts/*.sh   # Windows'tan kopyaladıysan CRLF temizliği
chmod +x /tmp/scripts/*.sh
/tmp/scripts/setup-wg.sh --endpoint vpn.senin-domain.com --port 51820 --pool 10.8.0.0/24
```

Script ne yapar:

1. `wireguard-tools` + `iptables` kurar (eksikse).
2. `net.ipv4.ip_forward=1` ve throughput ayarları — `/etc/sysctl.d/99-wireguard.conf` ile kalıcı.
3. Sunucu keypair'ini `/etc/wireguard/server_private.key` içinde üretir (mode 600).
4. `/etc/wireguard/wg-nat.sh` kurar — `PostUp`/`PostDown` bu scripti çağırır.
   NAT/forward/MSS-clamp kuralları `iptables -C` ile önce kontrol edilip
   ekleniyor, yani ikinci kez çalıştırmak kural çoğaltmaz.
5. `wg0.conf` yazar (`SaveConfig = false` — DB source of truth, wg-quick config'i
   ezmemeli).
6. Kernel ayarlarını yazar: socket buffer'ları, conntrack tablosu, BBR. Bkz. [docs/TUNING.md](docs/TUNING.md).
7. `wg-quick@wg0` servisini enable + start eder. Interface **zaten ayaktaysa
   peer'lara dokunmaz** — sadece NAT kurallarını tazeler.

> **Not:** script bilerek `wg syncconf` çağırmaz. `wg0.conf` içinde hiç `[Peer]`
> satırı yok (DB source of truth), dolayısıyla syncconf canlı interface'teki
> **bütün peer'ları silerdi**. Interface ayarlarını (port, MTU, pool) gerçekten
> değiştirmek istersen `--force` ile çalıştır; script sana
> `systemctl restart wg-quick@wg0` demeni söyler. Node ajanı bir sonraki
> sync'inde peer'ların hepsini geri yükler.

Sonunda `.env` bloğunu ekrana basar.

### Faz 1'de ne test etmeliyim

```bash
sudo wg show wg0                       # interface ayakta, ListenPort doğru
sysctl net.ipv4.ip_forward             # = 1
sudo iptables -t nat -L POSTROUTING -n | grep MASQUERADE
sudo /tmp/scripts/setup-wg.sh          # idempotency: "--" satırları görmelisin, hata yok
sudo iptables -t nat -L POSTROUTING -n | grep -c MASQUERADE   # hâlâ 1 olmalı

# Faz 2 canlıyken tekrar çalıştırdıysan: peer'lar duruyor mu?
sudo wg show wg0 peers | wc -l         # script öncesiyle aynı sayı olmalı
sudo reboot && sudo wg show wg0        # reboot sonrası otomatik ayağa kalkıyor mu
```

Ayrıca VPS sağlayıcının firewall'unda **51820/udp** açık olmalı.

---

## Faz 2 — Control plane API

### Endpoint'ler

| Method | Path | Auth | Açıklama |
|---|---|---|---|
| `POST` | `/auth/register` | — | Hesap açar, token döner |
| `POST` | `/auth/login` | — | Giriş |
| `POST` | `/auth/refresh` | — | Refresh token rotasyonu |
| `POST` | `/auth/logout` | — | Refresh token ailesini iptal eder |
| `GET` | `/auth/me` | Bearer | Hesap bilgisi |
| `DELETE` | `/auth/account` | Bearer + parola | Hesabı, cihazları ve anahtarları kalıcı siler (GDPR) |
| `POST` | `/devices` | Bearer | Yeni cihaz. Gövdede `publicKey` varsa sunucu anahtar **üretmez** |
| `GET` | `/devices` | Bearer | Cihazlar, her birinin bölge adresleri ve kullanım toplamları |
| `GET` | `/devices/:id/config` | Bearer | `.conf` içeriği. `?serverId=` bölge seçer |
| `POST` | `/devices/:id/rotate` | Bearer | Anahtarı değiştirir; id, etiket ve adresler aynı kalır |
| `DELETE` | `/devices/:id` | Bearer | Cihazı her yerden iptal eder |
| `GET` | `/servers` | Bearer | Bağlanılabilir bölgeler |
| `POST` | `/node/sync` | Node token | **Ajan protokolü**: durum + kullanım bildir, peer setini al |
| `GET` | `/health` | — | Liveness |
| `GET` | `/ready` | — | Node'lar sync ediyor mu, anahtarları eşleşiyor mu |

### Private key akışı (en kritik nokta)

**Varsayılan yol — anahtar cihazda üretilir, sunucu private key'i hiç görmez.**
Mullvad, NetBird ve ProtonVPN'in kullandığı model.

1. Flutter, X25519 keypair üretir (`WireGuardKeys.generate()`, RFC 7748 test
   vektörlerine karşı doğrulanmış). Private key `flutter_secure_storage`'a yazılır.
2. `POST /devices` gövdesinde **sadece** `publicKey` gider.
3. Response `privateKey: null` döner, `.conf` içinde `PrivateKey = <PRIVATE_KEY>`
   placeholder'ı vardır; app kendi anahtarını yerine koyar.

**Fallback — `publicKey` göndermezsen** sunucu `wg genkey` ile üretir ve private
key'i response'ta **bir kez** döner, DB'ye asla yazmaz. curl/script'ler için.

**Otomatik rotasyon.** App, bağlanırken anahtar `KEY_ROTATION_DAYS`'ten (varsayılan
7 gün, Mullvad ile aynı) eskiyse `POST /devices/:id/rotate` çağırır: yeni keypair
cihazda üretilir, sunucuya public key gider, tek bir `wg set` ile eski anahtar
düşer ve yenisi devreye girer. **Cihaz id'si, etiketi ve tünel IP'si değişmez,
cihaz kotasından yemez.** Böylece sızmış bir config kendiliğinden ölür.

Rotasyon **best-effort**: başarısız olursa kullanıcı eski anahtarıyla bağlanmaya
devam eder, hata gösterilmez. Sunucu tarafında `wg` başarısız olursa DB eski
anahtara geri alınır — DB ile interface asla ayrışmaz.

**Yetim anahtar tespiti.** App public key'i de saklar. Bağlanırken sunucunun
bildiği public key ile karşılaştırır; farklıysa (yarıda kalmış rotasyon, yedekten
geri yükleme) anahtarı yeniler. Bu kontrol olmasa tünel sonsuza kadar
"connecting" durumunda kalır ve hiçbir yerde hata görünmez.

Anahtar tamamen kaybolursa peer kurtarılamaz — `forgetDevice()` ile cihazı silip
yeniden eklemek gerekir.

### DB şeması — önerdiğinden farklar ve gerekçeleri

```sql
users(id, email, password_hash, created_at, disabled_at)

-- Kullanıcının yönettiği ve kotanın saydığı şey: tek keypair.
devices(id, user_id, label, platform, public_key,
        created_at, key_rotated_at, revoked_at)

-- Bir cihazı bir sunucuya bağlayan adres tahsisi. Kimlik değil.
peers(id, device_id, server_id, allowed_ip, preshared_key_enc,
      created_at, revoked_at)

-- Control plane'in konuştuğu node'lar.
servers(id, region, display_name, public_key, endpoint, listen_port,
        interface_name, address_pool_cidr, server_address, dns, is_default,
        status, agent_token_hash, last_seen_at, agent_version,
        reported_public_key, created_at)

peer_usage(peer_id, rx_bytes, tx_bytes, last_rx_counter, last_tx_counter,
           last_handshake_at, updated_at)

refresh_tokens(id, user_id, token_hash, family_id, expires_at, created_at, revoked_at)
```

**1. `devices` ile `peers` ayrı.** Başta peer'ın kendisi cihazdı. İkinci sunucuda
bu kırılıyor: bir cihazın ulaşabildiği her sunucuda adresi olması gerekiyor ve
bunları beş cihaz limitine saymak, üç bölgenin tek telefonla kotayı tüketmesi
demek olurdu. Kimlik `devices`'a taşındı, `peers` gerçekte ne ise o oldu.

**2. Bir cihazın tüm sunucularda tek açık anahtarı var.** WireGuard
(istemci, sunucu) çifti bazında doğruluyor, aynı istemci anahtarının birden çok
sunucuyla eşleşmesi normal. Bölge değiştirmeyi bir round trip değil, config'de
tek satır yapan şey bu.

**3. Partial unique index'ler** — asıl güvenlik mekanizması:
```sql
CREATE UNIQUE INDEX peers_active_ip_unique
  ON peers (server_id, allowed_ip) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX peers_active_device_server
  ON peers (device_id, server_id) WHERE revoked_at IS NULL;
```
Birincisi eş zamanlı tahsisi güvenli kılıyor. İkincisi olmadan bir retry
fırtınası tek cihaza aynı node'da birkaç adres verip hepsini sızdırırdı.
Revoke edilmiş satırlar audit için kalıyor ama adresi havuza geri bırakıyor.

**4. `servers.agent_token_hash`** — ajanın kimliği, HMAC olarak. Sızan bir
veritabanı node taklit etmeye yaramıyor. `status = draining` kimseyi düşürmeden
yeni tahsisi durduruyor, node'u kesintisiz emekliye ayırmanın yolu bu.

**5. `peer_usage.last_*_counter`** — WireGuard peer yeniden eklenince sayacı
sıfırlıyor. Ham okumayı saklamak, sıfırlamayı negatif deltadan ayırmak için;
naif çıkarma kullanıcının geçmişini silerdi.

**6. `preshared_key_enc` peer başına**, cihaz başına değil: sır o sunucuyla
paylaşılıyor, başkasıyla değil. AES-256-GCM (`PSK_ENCRYPTION_KEY`).

### Güvenlik varsayımları (açıkça)

- **IP tahsisi**: havuzdaki en düşük boş adres verilir. Öngörülebilir olması
  zararsız — peer'lar public key ile doğrulanıyor, adresle değil.
- **IP geri dönüşümü**: revoke edilen bir peer'ın adresi *hemen* havuza döner ve
  **başka bir kullanıcıya** verilebilir. Güvenli, çünkü aynı işlemde anahtar
  interface'ten siliniyor. Ama **trafik logu / abuse raporu tutacaksan zaman
  damgası şart** — "10.8.0.5 kimdi" sorusunun tek cevabı yok.
- **Yarış koşulu**: iki eşzamanlı `POST /devices` aynı IP'yi hesaplayabilir. DB
  partial unique index otoritedir; kaybeden taraf 6 kez yeniden dener.
- **Control plane WireGuard'a hiç dokunmuyor.** Anahtarları istemci üretiyor,
  PSK 32 rastgele bayt, peer'ları node'lardaki ajanlar uyguluyor. Sonuç: API
  ayrıcalıksız, `wg` binary'si olmayan bir makinede, container içinde
  çalışabiliyor. `sudo` ya da `CAP_NET_ADMIN` **control plane'de gerekmiyor** —
  sadece ajanda.
- **Node'lar çeker, control plane hiç dışarı aramaz.** Push modeli control
  plane'de her node'un root'unu veren bir kimlik gerektirirdi. Çekme modelinde
  node'lara WireGuard portu dışında gelen bağlantı gerekmiyor.
- **Bunun bedeli açık**: iptal **anında değil**, bir poll aralığında
  (`NODE_POLL_SECONDS`, varsayılan 10sn) yayılıyor. Bu, control plane'e her
  node'da root vermemenin karşılığı.
- **Ajan durum tutmuyor**: control plane ne cevaplarsa doğru odur. Bir saat
  offline kalan node ilk başarılı sync'te kendine geliyor — reboot sonrası
  ayrı bir kurtarma yolu yok, aynı yol.
- **Sync başarısız olursa ajan peer tablosuna dokunmuyor.** Control plane
  kesintisini tam kesintiye çevirmek yanlış yön.
- **Her istekte hesap kontrolü**: `requireAuth` sadece JWT imzasını değil,
  hesabın hâlâ var ve aktif olduğunu da kontrol eder. Aksi halde silinmiş ya da
  askıya alınmış bir hesabın access token'ı 15 dakika daha geçerli kalırdı.
  Maliyet: istek başına bir PK okuması (in-process SQLite). DB süreç dışına
  taşınırsa bu kontrolü **kaldırma**, kısa TTL'li cache koy.
- **Hesap silme geri alınamaz**: `DELETE /auth/account` parola ister (çalınmış
  access token tek başına hesap silmeye yetmemeli), önce cihazları iptal eder,
  sonra `users` satırını siler — `ON DELETE CASCADE` cihazları, onların
  peer'larını ve refresh token'ları götürür. Tombstone bırakmaz; erasure
  talebinin karşılığı bu. Yanlış parola **403** döner, 401 değil: 401 istemcide
  "token öldü" gibi görünüp bir yazım hatasını oturum kapatmaya çevirirdi.
- **Ajan config'i argv'ye ulaşmadan doğruluyor.** Control plane TLS üzerinden
  güvenilir ama her node'da root çalışan bir komuta argüman enjekte edecek
  kadar değil.
- **Parola**: `node:crypto` scrypt (N=2^15). bcrypt/argon2 native build
  gerektiriyor; better-sqlite3 zaten derleniyor, ikinci bir native bağımlılık
  istemedim. Min 10 karakter, kompozisyon kuralı yok.
- **Refresh token JWT değil**: opaque 48-byte rastgele string, DB'de sadece
  HMAC'i saklanıyor. Gerekçe: iptal edilebilir olması ve DB sızıntısında
  doğrudan kullanılamaması. Access token JWT (HS256, 15 dk).
- **Reuse detection**: kullanılmış bir refresh token tekrar sunulursa o
  login'den türeyen bütün aile iptal edilir.
- **Kullanıcı sayımı sızıntısı yok**: bilinmeyen e-postada da gerçek bir scrypt
  hesabı yapılır, yanıt süresi eşitlenir. Başkasının peer'ı 403 değil 404 döner.
- **IPv6 kapsam dışı**: havuz IPv4. Client `AllowedIPs` içinde `::/0` var, yani
  IPv6 trafiği tünele girip düşer (sızmaz), ama IPv6 çıkışı yok.

### Rate limit

| Kapsam | Pencere | Limit |
|---|---|---|
| `/health`, `/ready` (IP) | 1 dk | 120 |
| Global (IP) | 15 dk | 300 |
| `/auth/register`, `/auth/login`, `DELETE /auth/account` (IP) | 15 dk | 10 |
| `/auth/refresh`, `/auth/logout` (IP) | 15 dk | 60 |
| `POST`/`DELETE /devices` (**kullanıcı**) | 1 saat | 30 |
| `POST /node/sync` (node) | 1 dk | 120 |

Peer yazma limiti IP değil kullanıcı bazlı — carrier NAT arkasındaki kullanıcılar
birbirini aç bırakmasın diye.

Probe'lar global limitten **önce** ve ayrı bütçeyle mount ediliyor: 5 saniyede bir
ping atan bir uptime monitörü aksi halde 15 dakikalık pencerenin 180/300'ünü yer
ve gerçek kullanıcılar 429 alırdı. Ayrıca `express.json()` limiter'dan **sonra**
çalışıyor — 429 yiyecek bir istek önce 32kb JSON parse ettirmesin diye.

### Faz 2'de ne test etmeliyim

```bash
cd server
npm test                 # 127 test
npm run typecheck        # strict mode, src + tests
npm run build
```

Elle (dev makinede, mock modda):

```bash
npm run dev
curl -s localhost:3000/ready | jq

TOKENS=$(curl -sX POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@test.dev","password":"a-long-enough-password"}')
AT=$(echo "$TOKENS" | jq -r .tokens.accessToken)

# 1. Peer oluştur — privateKey burada, bir daha görmeyeceksin
curl -sX POST localhost:3000/devices -H "authorization: Bearer $AT" \
  -H 'content-type: application/json' -d '{"deviceLabel":"Telefon"}' | jq -r .conf

# 2. Aynı config'i tekrar iste — PrivateKey = <PRIVATE_KEY> olmalı
curl -s localhost:3000/devices/1/config -H "authorization: Bearer $AT" | jq -r .conf

# 3. Cihaz limiti (MAX_DEVICES_PER_USER=5) → 6. istekte 409 peer_quota_exceeded
# 4. Sil → 204, sonra GET /devices/1/config → 404
curl -sX DELETE localhost:3000/devices/1 -H "authorization: Bearer $AT" -i | head -1
```

Gerçek sunucuda ek olarak:

```bash
sudo wg show wg0                 # ajan sync ettikten sonra peer listede görünmeli
curl -s localhost:3000/ready | jq .wireguard.keyMatchesConfig   # true olmalı
sudo systemctl restart vpn-api   # log'da "interface synced from database"
```

`keyMatchesConfig: false` görürsen `.env` içindeki `WG_SERVER_PUBLIC_KEY` canlı
interface ile uyuşmuyor demektir — client'lara handshake yapamayacakları bir
config gidiyor.

### Production deploy

```bash
# VPS'te
sudo mkdir -p /opt/vpn-control-plane && sudo chown wgapi:wgapi /opt/vpn-control-plane
# kaynağı kopyala, sonra:
cd /opt/vpn-control-plane
npm ci --omit=dev && npm run build     # veya lokalde build edip dist/ kopyala
cp .env.example .env && npm run keygen  # çıktıyı .env'e yaz
# setup-wg.sh'in bastığı WG_* değerlerini de .env'e yaz, NODE_ENV=production

sudo cp deploy/vpn-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vpn-api
sudo journalctl -u vpn-api -f

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # domain'i düzenle
sudo systemctl reload caddy
```

`NODE_ENV=production` iken env doğrulaması placeholder
secret'ları reddeder — süreç açılmaz.

---

## Faz 3 — Flutter client

```
lib/
├── config.dart              --dart-define ile override edilen ayarlar
├── core/
│   ├── api_client.dart      401 → tek seferlik refresh → replay (single-flight)
│   ├── api_exception.dart   backend error.code'unu taşır
│   └── secure_store.dart    JWT + WireGuard private key
├── models/models.dart
├── services/                auth / peer repository, tunnel service
├── state/                   AuthController, VpnController (ChangeNotifier)
└── ui/                      LoginScreen, HomeScreen
```

**Paket seçimi**: `wireguard_flutter` (0.1.3) ~2 yıldır güncellenmemiş.
Bunun yerine **`wireguard_flutter_plus` 1.0.7** kullanıldı — aynı
`WireGuardFlutter` API'si, verified publisher, Android 16KB page size desteği
(Play Store zorunluluğu) ve trafik istatistikleri var.

**Single-flight refresh kritik**: backend refresh token'ı rotate ediyor ve
tekrar kullanımı sızıntı sayıp bütün aileyi iptal ediyor. İki paralel istek aynı
anda 401 alıp ikisi de refresh çağırsaydı kullanıcı otomatik logout olurdu.
`ApiClient._refreshInFlight` bunu engelliyor.

**UI dili İngilizce** — lokalizasyon eklemek istersen string'ler ekran
dosyalarında toplu duruyor.

### Masaüstünde ne değişir

Uygulama aynı, tünel yolu farklı: GUI ayrıcalıksız çalışır ve `vpnd` servisiyle
AF_UNIX soketi üzerinden konuşur. Test etmek için daemon'u mock sürücüyle
çalıştırıp uygulamayı ona bağlayabilirsin:

```bash
cd vpnd && go run ./cmd/vpnd -mock -socket /tmp/vpnd.sock
cd apps/client && flutter run -d windows   # ya da macos / linux
```

Servis çalışmıyorken Connect'e basınca **"The VPN service is not running"**
demeli — üç katman aşağıdan gelen bir istisna değil.

Protokolü elle sürmek için:

```bash
cd vpnd && go run ./cmd/vpnctl -socket /tmp/vpnd.sock status
```

### Ne test etmeliyim

Backend'i dev makinede çalıştır, Android emulator aç:

```bash
cd server && npm run dev
cd apps/client && flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

1. **Register** → hesap açılır, direkt Home ekranı gelir.
2. **Uygulamayı kapat/aç** → login ekranı gelmemeli (token secure storage'da).
3. **Connect'e bas** → ilk basışta sistem VPN izni sorar. Kabul et.
   - Mock backend gerçek tünel kurmaz; **gerçek testi VPS deploy'undan sonra yap.**
4. **İzni reddet** → "The system VPN profile was not allowed." banner'ı çıkmalı.
5. **Backend'i durdur, Connect'e bas** → "Cannot reach the VPN service." banner'ı.
6. **Menü → Remove this device** → onay dialogu, sonra `GET /devices` boş döner.
6b. **Bağlıyken Sign out** → tünel kapanmalı, cihaz sunucudan revoke edilmeli
   (`GET /devices` boş) ve başka bir hesapla girince önceki kullanıcının cihaz
   etiketi/tünel IP'si **görünmemeli**.
6c. **Rotasyonu gör:** `flutter run --dart-define=KEY_ROTATION_DAYS=0` ile çalıştır,
   her Connect'te `POST /devices/:id/rotate` düşmeli; `GET /devices` içindeki
   `publicKey` her seferinde değişirken `id` ve `allowedIp` sabit kalmalı.
6d. **Kill switch:** menü → Kill switch → "Open VPN settings" Android'in VPN
   ayarlarını açmalı.
7. **Cihaz limitini doldur** (`MAX_DEVICES_PER_USER=1` yapıp restart) → Connect
   basınca quota mesajı + "You can remove a device from this screen."
8. **Sign out** → private key de silinir (`clearAll`).

Gerçek tünel testi (VPS hazır olduktan sonra):

```bash
flutter run --release --dart-define=API_BASE_URL=https://api.senin-domain.com
```
Bağlandıktan sonra telefonda `whatismyip` → VPS'in IP'si görünmeli, ve VPS'te
`sudo wg show wg0` son handshake zamanını göstermeli.

```bash
dart analyze packages apps    # temiz
```

### Yapman gereken manuel adımlar

- **applicationId**: şu an `com.example.vpn_client`. Kendi domain'ine çevir
  (`apps/client/android/app/build.gradle.kts` + `namespace`). Aynı ismi
  `MainActivity.kt`'deki MethodChannel adında ve eklentinin native host
  manifest'inde de güncelle.
- **iOS**: `startVpn` bir Network Extension target'ı gerektiriyor. Xcode'da
  "Network Extension" target ekle, App Group tanımla ve bundle id'yi
  `--dart-define=IOS_EXTENSION_BUNDLE_ID=...` ile geç.
- **HTTPS**: `network_security_config.xml` cleartext'i sadece `10.0.2.2` ve
  `localhost` için açıyor. Gerçek domain'ini oraya **ekleme** — HTTPS kullan.
- **Eklenti ID'si**: Chrome yükledikten sonra verdiği ID'yi
  `extension/native-host/*.json` içine yaz — bkz.
  [extension/README.md](extension/README.md).
- **`API_BASE_URL`**: derleme zamanı sabiti. Release pipeline bunu
  `vars.API_BASE_URL` repo değişkeninden alıyor; ayarlamazsan release build
  emulator loopback adresine bakar.

---

---

## Test kapsamı

Üç yığın, üç komut:

```bash
cd server && npm test                       # 127
cd vpnd   && go test ./...                  # 4 paket
dart pub get && dart analyze packages apps  # workspace
```

**Backend — 127 test** (`cd server && npm test`)

| Dosya | Ne doğruluyor |
|---|---|
| `api.test.ts` (31) | Uçtan uca auth + peer CRUD + client keygen + anahtar rotasyonu + hesap silme |
| `persistence.test.ts` (25) | Partial unique index'ler, CASCADE, migration idempotency, FK RESTRICT |
| `resilience.test.ts` (18) | Node protokolü izolasyonu, kullanım sayaçları, eş zamanlı tahsis, Eş zamanlı peer oluşturma, `wg` hatası telafisi, havuz tükenmesi, hasmane girdi |
| `utils.test.ts` (16) | IPv4 aritmetiği, WireGuard anahtar formatı, e-posta doğrulama |
| `env.test.ts` (12) | Yanlış yapılandırmada süreç ayağa kalkmasın |
| `crypto.test.ts` (10), `ipam.test.ts` (9), `configRenderer.test.ts` (6) | Şifreleme, adres tahsisi, `.conf` üretimi |

**Dart — 90 test**

| Paket | Ne doğruluyor |
|---|---|
| `vpn_client` (42) | Client keygen, **otomatik rotasyon**, yetim anahtar tespiti, oturum sonu temizliği |
| `vpn_api` (26) | 401 → tek seferlik refresh → replay, **single-flight refresh**, ağ/TLS hata haritalama |
| `vpn_tunnel_desktop` (13) | Gerçek AF_UNIX soketi üzerinden sahte daemon: protokol handshake, reconnect, servis ölümü |
| `vpn_crypto` (9) | **RFC 7748 §6.1 test vektörleri**, clamping, üretilen çiftin tutarlılığı |

**Go — vpnd**

| Paket | Ne doğruluyor |
|---|---|
| `internal/tunnel` | Config allowlist'i (**PostUp = root shell**), driver argv'si, idempotency |
| `internal/ipc` | Uçtan uca protokol, düşman config reddi, yavaş abone state machine'i kilitlemesin |
| `internal/protocol` | Çerçeveleme, boyut sınırı, log redaksiyonu |
| `cmd/vpn-browser-host` | Eklentinin **tam üç eyleme** erişebildiği, `up`'a erişemediği |

Gerçek yollar test ediliyor, mock'lanmış kopyalar değil: `wg` binary'si
`CommandRunner` enjeksiyonuyla, `flutter_secure_storage` platform kanalı
mock'lanarak, vpnd IPC'si gerçek soket üzerinden.

Anahtar türetmesi kendi kendiyle tutarlılığa değil **RFC test vektörlerine**
sabitlendi: yanlış türetmede tünel hiçbir hata vermeden asla handshake yapmaz.

CI'da dashboard'un web build'i katman sınırlarının bekçisi — birisi `vpn_api`'ye
Flutter eklerse build kırılır.

---

## Kill switch

Uygulama **in-app kill switch yerine Android'in yerleşiğine yönlendiriyor**
(menü → Kill switch). Gerekçe teknik: Android'de aynı anda tek bir `VpnService`
aktif olabilir, dolayısıyla tünel durup engelleyici servis başlayana kadar her
zaman bir boşluk kalır ve trafik oradan sızar. Android'in "Always-on VPN +
Block connections without VPN" ayarı ise işletim sistemi seviyesinde, tüm
uygulamaların altında uygulanır ve sızdırmaz.

`MainActivity.kt` içindeki MethodChannel `Settings.ACTION_VPN_SETTINGS`'i açar,
bulunamazsa `ACTION_WIRELESS_SETTINGS`'e düşer, o da yoksa `false` döner ve ekran
yazılı adımları gösterir — çalışmayan bir buton göstermez.

iOS'ta karşılığı Network Extension'da `includeAllNetworks`; extension target'ı
eklendiğinde yapılacak.

## Bilinen açıklar (bilerek yapılmadı)

1. **E-posta doğrulama yok.** Kimse adresini kanıtlamıyor. SMTP sağlayıcı seçimi
   senin kararın (Postmark/SES/Resend); yarım bir doğrulama akışı hiç
   olmamasından kötü, o yüzden başlamadım.
2. **Ödeme/abonelik yok.** Kayıt olan herkes 5 peer alıyor.
3. **`POST_NOTIFICATIONS` runtime'da istenmiyor.** Manifest'te var ama Android
   13+'ta izin sorulmadığı için foreground service bildirimi görünmüyor.
   `permission_handler` paketi gerekiyor.
4. **Trafik istatistiği gösterilmiyor.** `wireguard_flutter_plus` zaten
   `trafficSnapshot` stream'i veriyor (hız + toplam), sunucu tarafı gerekmeden
   client'ta gösterilebilir.
5. **Hesap numarası yerine e-posta.** Mullvad bilerek e-posta istemiyor —
   e-posta tutmak seni PII sahibi yapar ve GDPR kapsamını genişletir. Ürün
   kararı, kod değil.

## Durum

| Parça | Durum | Doğrulama |
|---|---|---|
| Control plane | Tamam | 149 test, canlı smoke test |
| Dart katmanları | Tamam | 87 test, `dart analyze` temiz |
| vpnd daemon | Tamam | Go testleri, mock driver ile canlı |
| Mobil uygulama | Kod tamam | **APK build doğrulanmadı** |
| Masaüstü uygulama | Kod tamam | **exe build doğrulanmadı** |
| Web dashboard | Tamam | `flutter build web` başarılı |
| Tarayıcı eklentisi | Kod tamam | Köprü elle doğrulandı, Chrome'da test edilmedi |
| Website + CI | Kod tamam | Pipeline hiç çalışmadı |

**Hiçbir şey gerçek tünelde test edilmedi.** Her şey mock ile doğrulandı;
gerçek handshake VPS deploy'undan sonra görülecek.

Build doğrulaması için Windows'ta Developer Mode gerekiyor
(`start ms-settings:developers`). Açılana kadar eski `app/` dizini de duruyor —
yeni `apps/client` doğrulanmadan silmedim.

## Sırada ne var

1. **VPS deploy** — `setup-wg.sh`, sonra control plane, sonra gerçek tünel.
2. **Kod imzalama** — Apple Developer başvurusunu erken yap, onay haftalar sürer.
3. **E-posta doğrulama ve ödeme** — ürün kararları, kod bekliyor.
4. **Çoklu sunucu** — şema hazır (`servers` tablosu + `server_id` FK), seçim
   arayüzü yok.
5. **Bandwidth tracking** — `wg show wg0 dump` parse; `wireguard_flutter_plus`
   zaten istemci tarafında `trafficSnapshot` veriyor ve kullanılmıyor.
