# WireGuard VPN — Control Plane + Flutter Client

Kendi VPS'in üzerinde çalışan WireGuard tabanlı VPN servisi: Node.js/TypeScript
control plane + Flutter mobil client.

```
Vpn/
├── server/                 Node.js + Express + TypeScript control plane
│   ├── scripts/            Faz 1 — sunucu kurulum scriptleri (bash)
│   ├── deploy/             systemd unit + Caddyfile
│   ├── src/                Faz 2 — API
│   └── tests/              43 test (vitest + supertest)
└── app/                    Faz 3 — Flutter client (Android + iOS)
```

---

## Hızlı başlangıç (geliştirme makinesi, WireGuard gerekmez)

```bash
cd server
npm install
npm test          # 43 test
npm run dev       # http://localhost:3000
```

`.env` zaten `WG_MOCK=true` ile hazır. Mock backend gerçek Curve25519 anahtarları
üretir — yani mock modda üretilen `.conf` dosyası geçerli bir config'dir, sadece
sunucu tarafındaki peer tablosu simüle edilir.

Flutter tarafı:

```bash
cd app
flutter pub get
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000   # Android emulator
```

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
2. `net.ipv4.ip_forward=1` — `/etc/sysctl.d/99-wireguard.conf` ile kalıcı.
3. Sunucu keypair'ini `/etc/wireguard/server_private.key` içinde üretir (mode 600).
4. `/etc/wireguard/wg-nat.sh` kurar — `PostUp`/`PostDown` bu scripti çağırır.
   NAT/forward/MSS-clamp kuralları `iptables -C` ile önce kontrol edilip
   ekleniyor, yani ikinci kez çalıştırmak kural çoğaltmaz.
5. `wg0.conf` yazar (`SaveConfig = false` — DB source of truth, wg-quick config'i
   ezmemeli).
6. `wgapi` sistem kullanıcısı + dar kapsamlı `/etc/sudoers.d/wgapi` oluşturur.
7. `wg-quick@wg0` servisini enable + start eder. Interface **zaten ayaktaysa
   peer'lara dokunmaz** — sadece NAT kurallarını tazeler.

> **Not:** script bilerek `wg syncconf` çağırmaz. `wg0.conf` içinde hiç `[Peer]`
> satırı yok (DB source of truth), dolayısıyla syncconf canlı interface'teki
> **bütün peer'ları silerdi**. Interface ayarlarını (port, MTU, pool) gerçekten
> değiştirmek istersen `--force` ile çalıştır; script sana
> `systemctl restart wg-quick@wg0 && systemctl restart vpn-api` demeni söyler.
> vpn-api açılışta DB'deki aktif peer'ların hepsini geri yükler.

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
| `DELETE` | `/auth/account` | Bearer + parola | Hesabı, peer'ları ve anahtarları kalıcı siler (GDPR) |
| `POST` | `/peers` | Bearer | Yeni cihaz. Gövdede `publicKey` varsa sunucu anahtar **üretmez** |
| `POST` | `/peers/:id/rotate` | Bearer | Cihazın anahtarını değiştirir, id ve IP aynı kalır |
| `GET` | `/peers` | Bearer | Kullanıcının aktif peer'ları |
| `GET` | `/peers/:id/config` | Bearer | `.conf` içeriği (private key yerine placeholder) |
| `DELETE` | `/peers/:id` | Bearer | Peer'ı interface'ten ve DB'den kaldırır |
| `GET` | `/health` | — | Liveness |
| `GET` | `/ready` | — | DB + interface + anahtar eşleşmesi |

### Private key akışı (en kritik nokta)

**Varsayılan yol — anahtar cihazda üretilir, sunucu private key'i hiç görmez.**
Mullvad, NetBird ve ProtonVPN'in kullandığı model.

1. Flutter, X25519 keypair üretir (`WireGuardKeys.generate()`, RFC 7748 test
   vektörlerine karşı doğrulanmış). Private key `flutter_secure_storage`'a yazılır.
2. `POST /peers` gövdesinde **sadece** `publicKey` gider.
3. Response `privateKey: null` döner, `.conf` içinde `PrivateKey = <PRIVATE_KEY>`
   placeholder'ı vardır; app kendi anahtarını yerine koyar.

**Fallback — `publicKey` göndermezsen** sunucu `wg genkey` ile üretir ve private
key'i response'ta **bir kez** döner, DB'ye asla yazmaz. curl/script'ler için.

**Otomatik rotasyon.** App, bağlanırken anahtar `KEY_ROTATION_DAYS`'ten (varsayılan
7 gün, Mullvad ile aynı) eskiyse `POST /peers/:id/rotate` çağırır: yeni keypair
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
servers(id, region, public_key, endpoint, listen_port, interface_name,
        address_pool_cidr, server_address, dns, is_default, created_at)
peers(id, user_id, server_id, public_key, preshared_key_enc, allowed_ip,
      device_label, created_at, revoked_at)
refresh_tokens(id, user_id, token_hash, family_id, expires_at, created_at, revoked_at)
```

1. **`peers.server_id`** eklendi. `allowed_ip` sadece bir sunucunun havuzu
   içinde tekil; server_id olmadan Faz 4'te migration gerekir.
2. **`servers`** tablosuna `address_pool_cidr`, `server_address`,
   `interface_name`, `dns`, `is_default` eklendi — IP tahsisi bu bilgilere
   ihtiyaç duyuyor ve env'de bırakılırsa çoklu sunucuda çalışmaz.
3. **Partial unique index'ler** — asıl güvenlik mekanizması:
   ```sql
   CREATE UNIQUE INDEX peers_active_ip_unique
     ON peers (server_id, allowed_ip) WHERE revoked_at IS NULL;
   ```
   Revoke edilmiş satırlar audit için kalır ama IP'yi havuza geri bırakır.
4. **`preshared_key_enc`** — PSK opsiyonel (`WG_ENABLE_PRESHARED_KEY`).
   Sunucu tarafında da gerektiği için saklanmak zorunda; AES-256-GCM ile
   şifreli (`PSK_ENCRYPTION_KEY`).
5. **`refresh_tokens`** — rotasyon + reuse detection için ayrı tablo.
6. **`users.disabled_at`** — hesabı peer'ları silmeden askıya alabilmek için.

### Güvenlik varsayımları (açıkça)

- **IP tahsisi**: havuzdaki en düşük boş adres verilir. Öngörülebilir olması
  zararsız — peer'lar public key ile doğrulanıyor, adresle değil.
- **IP geri dönüşümü**: revoke edilen bir peer'ın adresi *hemen* havuza döner ve
  **başka bir kullanıcıya** verilebilir. Güvenli, çünkü aynı işlemde anahtar
  interface'ten siliniyor. Ama **trafik logu / abuse raporu tutacaksan zaman
  damgası şart** — "10.8.0.5 kimdi" sorusunun tek cevabı yok.
- **Yarış koşulu**: iki eşzamanlı `POST /peers` aynı IP'yi hesaplayabilir. DB
  partial unique index otoritedir; kaybeden taraf 6 kez yeniden dener.
- **Sıralama**: peer oluştururken önce DB satırı yazılır (adres rezervasyonu),
  sonra `wg set`. `wg` başarısız olursa satır revoke edilip adres geri bırakılır.
  Revoke ederken tersi: önce DB, sonra `wg`. İkinci adım patlarsa boot-time sync
  temizler — ters sıra iptal edilmiş bir anahtarı geri diriltebilirdi.
- **Boot sync**: `wg set` state'i reboot'ta kaybolur. `WG_SYNC_ON_BOOT=true` ile
  açılışta DB'deki tüm aktif peer'lar yeniden uygulanır, DB'de olmayanlar silinir.
- **Her istekte hesap kontrolü**: `requireAuth` sadece JWT imzasını değil,
  hesabın hâlâ var ve aktif olduğunu da kontrol eder. Aksi halde silinmiş ya da
  askıya alınmış bir hesabın access token'ı 15 dakika daha geçerli kalırdı.
  Maliyet: istek başına bir PK okuması (in-process SQLite). DB süreç dışına
  taşınırsa bu kontrolü **kaldırma**, kısa TTL'li cache koy.
- **Hesap silme geri alınamaz**: `DELETE /auth/account` parola ister (çalınmış
  access token tek başına hesap silmeye yetmemeli), önce peer'ları interface'ten
  düşürür, sonra `users` satırını siler — `ON DELETE CASCADE` peer'ları ve
  refresh token'ları da götürür. Tombstone bırakmaz; erasure talebinin karşılığı
  bu. Sıra önemli: DB önce silinseydi anahtarlar interface'te sahipsiz kalırdı ve
  boot sync onları asla göremezdi.
- **Root değil**: API `wgapi` kullanıcısı olarak çalışır. systemd unit
  `AmbientCapabilities=CAP_NET_ADMIN` veriyor — `wg` için yeterli, sudo gerekmez.
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
| `POST`/`DELETE /peers` (**kullanıcı**) | 1 saat | 30 |

Peer yazma limiti IP değil kullanıcı bazlı — carrier NAT arkasındaki kullanıcılar
birbirini aç bırakmasın diye.

Probe'lar global limitten **önce** ve ayrı bütçeyle mount ediliyor: 5 saniyede bir
ping atan bir uptime monitörü aksi halde 15 dakikalık pencerenin 180/300'ünü yer
ve gerçek kullanıcılar 429 alırdı. Ayrıca `express.json()` limiter'dan **sonra**
çalışıyor — 429 yiyecek bir istek önce 32kb JSON parse ettirmesin diye.

### Faz 2'de ne test etmeliyim

```bash
cd server
npm test                 # 133 test
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
curl -sX POST localhost:3000/peers -H "authorization: Bearer $AT" \
  -H 'content-type: application/json' -d '{"deviceLabel":"Telefon"}' | jq -r .conf

# 2. Aynı config'i tekrar iste — PrivateKey = <PRIVATE_KEY> olmalı
curl -s localhost:3000/peers/1/config -H "authorization: Bearer $AT" | jq -r .conf

# 3. Cihaz limiti (MAX_PEERS_PER_USER=5) → 6. istekte 409 peer_quota_exceeded
# 4. Sil → 204, sonra GET /peers/1/config → 404
curl -sX DELETE localhost:3000/peers/1 -H "authorization: Bearer $AT" -i | head -1
```

Gerçek sunucuda ek olarak:

```bash
sudo wg show wg0                 # POST /peers sonrası peer listede görünmeli
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

`NODE_ENV=production` iken env doğrulaması `WG_MOCK=true`'yu ve placeholder
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

### Faz 3'te ne test etmeliyim

Backend'i dev makinede çalıştır, Android emulator aç:

```bash
cd server && npm run dev
cd app && flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

1. **Register** → hesap açılır, direkt Home ekranı gelir.
2. **Uygulamayı kapat/aç** → login ekranı gelmemeli (token secure storage'da).
3. **Connect'e bas** → ilk basışta sistem VPN izni sorar. Kabul et.
   - Mock backend gerçek tünel kurmaz; **gerçek testi VPS deploy'undan sonra yap.**
4. **İzni reddet** → "The system VPN profile was not allowed." banner'ı çıkmalı.
5. **Backend'i durdur, Connect'e bas** → "Cannot reach the VPN service." banner'ı.
6. **Menü → Remove this device** → onay dialogu, sonra `GET /peers` boş döner.
6b. **Bağlıyken Sign out** → tünel kapanmalı, cihaz sunucudan revoke edilmeli
   (`GET /peers` boş) ve başka bir hesapla girince önceki kullanıcının cihaz
   etiketi/tünel IP'si **görünmemeli**.
6c. **Rotasyonu gör:** `flutter run --dart-define=KEY_ROTATION_DAYS=0` ile çalıştır,
   her Connect'te `POST /peers/:id/rotate` düşmeli; `GET /peers` içindeki
   `publicKey` her seferinde değişirken `id` ve `allowedIp` sabit kalmalı.
6d. **Kill switch:** menü → Kill switch → "Open VPN settings" Android'in VPN
   ayarlarını açmalı.
7. **Cihaz limitini doldur** (`MAX_PEERS_PER_USER=1` yapıp restart) → Connect
   basınca quota mesajı + "You can remove a device from this screen."
8. **Sign out** → private key de silinir (`clearAll`).

Gerçek tünel testi (VPS hazır olduktan sonra):

```bash
flutter run --release --dart-define=API_BASE_URL=https://api.senin-domain.com
```
Bağlandıktan sonra telefonda `whatismyip` → VPS'in IP'si görünmeli, ve VPS'te
`sudo wg show wg0` son handshake zamanını göstermeli.

```bash
cd app
flutter analyze     # temiz
flutter test        # 47 test
```

### Yapman gereken manuel adımlar

- **applicationId**: şu an `com.example.vpn_client`. Kendi domain'ine çevir
  (`android/app/build.gradle.kts` + `namespace`).
- **iOS**: `startVpn` bir Network Extension target'ı gerektiriyor. Xcode'da
  "Network Extension" target ekle, App Group tanımla ve bundle id'yi
  `--dart-define=IOS_EXTENSION_BUNDLE_ID=...` ile geç. Android'de bu parametre
  yok sayılıyor, o yüzden Android tarafı şu an tam çalışır durumda.
- **HTTPS**: `network_security_config.xml` cleartext'i sadece `10.0.2.2` ve
  `localhost` için açıyor. Gerçek domain'ini oraya **ekleme** — HTTPS kullan.

---

---

## Test kapsamı

**Backend — 146 test** (`cd server && npm test`)

| Dosya | Ne doğruluyor |
|---|---|
| `cliWireGuard.test.ts` (20) | Production'da çalışan `wg` yolu: argv, sudo, PSK'nın dosyayla geçmesi, batch sync |
| `api.test.ts` (44) | Uçtan uca auth + peer CRUD + client keygen + anahtar rotasyonu + hesap silme |
| `persistence.test.ts` (16) | Partial unique index'ler, CASCADE, migration idempotency, FK RESTRICT |
| `resilience.test.ts` (13) | Eş zamanlı peer oluşturma, `wg` hatası telafisi, havuz tükenmesi, hasmane girdi |
| `utils.test.ts` (16) | IPv4 aritmetiği, WireGuard anahtar formatı, e-posta doğrulama |
| `env.test.ts` (12) | Yanlış yapılandırmada süreç ayağa kalkmasın |
| `crypto.test.ts` (10), `ipam.test.ts` (9), `configRenderer.test.ts` (6) | Şifreleme, adres tahsisi, `.conf` üretimi |

**Flutter — 72 test** (`cd app && flutter test`)

| Dosya | Ne doğruluyor |
|---|---|
| `controllers_test.dart` (34) | Client keygen, **otomatik rotasyon**, yetim anahtar tespiti, çıkışta tünel+cihaz temizliği |
| `api_client_test.dart` (17) | 401 → tek seferlik refresh → replay, **single-flight refresh**, ağ/TLS hata haritalama |
| `wireguard_keys_test.dart` (9) | **RFC 7748 §6.1 test vektörleri**, clamping, üretilen çiftin tutarlılığı |
| `system_settings_test.dart` (8) | Kill switch köprüsü: açılamama, platform hatası, eksik implementasyon |
| `models_test.dart` (4) | JSON çözümleme, private key placeholder değişimi |

Anahtar türetmesi kendi kendiyle tutarlılığa değil **RFC test vektörlerine**
sabitlendi: yanlış türetmede tünel hiçbir hata vermeden asla handshake yapmaz.

`wg` binary'si ve `flutter_secure_storage` platform kanalı sahte implementasyonlarla
değiştirildi, yani gerçek kod yolları test ediliyor — mock'lanmış bir kopya değil.

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

## Faz 4 (henüz başlanmadı)

Çoklu sunucu, bandwidth tracking (`wg show wg0 dump` parse), admin paneli.
Şema ve servis katmanı bunlara hazır (`servers` tablosu + `server_id` FK), ama
Faz 1-3 gerçek VPS'te stabil çalışmadan başlamayacağız.
