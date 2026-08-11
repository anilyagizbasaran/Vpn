# Canlıya alma sırası

Her adımın sonunda bir doğrulama var. Bir adım kırmızıysa sonrakine geçme —
sonraki adımın hatası hep aynı belirsiz mesajla görünür ("connecting…"), ve
gerçek sebebi geriye doğru bulmak saatler alır.

## 0. Öncesi

```bash
# Yerelde, deploy öncesi son kontrol
cd server && npm test && npm run typecheck
cd vpnd   && go test ./... && go vet ./...
dart pub get && dart analyze packages apps
```

## 1. WireGuard sunucusu

```bash
# VPS'te (Ubuntu/Debian, root)
sed -i 's/\r$//' scripts/*.sh          # Windows'tan kopyaladıysan
chmod +x scripts/*.sh
./scripts/setup-wg.sh --endpoint vpn.senin-domain.com --port 51820
```

**Doğrula:**

```bash
sudo ./scripts/verify-deploy.sh
```

Bu aşamada control plane henüz yok, yani "vpn-api is not running" bekleniyor.
Kırmızı olmaması gerekenler: interface, forwarding, MASQUERADE, port.

## 2. Control plane

İki yol var, ikisi de aynı sonucu veriyor. `.env` her ikisinde de aynı dosya:
`setup-wg.sh`'in bastığı `WG_*` değerleri + `npm run keygen` çıktısı, artı
`NODE_ENV=production`, `TRUST_PROXY=1`, `WG_SKIP_BOOTSTRAP_NODE=true`.

**a) systemd ile**

```bash
sudo systemctl enable --now vpn-api
sudo systemctl reload caddy
```

**b) Docker ile** — Caddy'yi de birlikte getirir

```bash
# server/deploy/Caddyfile.docker içindeki api.example.com'u kendi domain'inle
# değiştir; Caddy açılışta Let's Encrypt'e o isim için sertifika soruyor.
docker compose up -d
docker compose ps        # api "healthy" olmalı
```

Control plane'in artık hiçbir ayrıcalığa ihtiyacı olmaması bunu mümkün kılan
şey: container `cap_drop: ALL`, `read_only` ve `no-new-privileges` ile
çalışıyor, yazdığı tek yer veritabanı volume'ü.

WireGuard container'da **değil**. `wg0` host'un kernel arayüzü; `setup-wg.sh`
onu ayağa kaldırıyor ve `docker compose down` dahil her şeye rağmen ayakta
kalıyor. Peer'lar container yeniden kurulunca kaybolmuyor.

**Doğrula:**

```bash
sudo ./scripts/verify-deploy.sh   # ajan henüz yok, node uyarısı normal
```

Kabul testi ajandan sonra çalıştırılır — bir sonraki adımın sonunda.

## 3. Node ajanı

> **Tek sunucuda da gerekiyor.** Control plane artık WireGuard'a hiç dokunmuyor
> — ayrıcalıksız çalışabilmesinin sebebi bu. Ajan olmadan peer'lar veritabanında
> var, interface'te yok.

Control plane ayakta olduğuna göre node'u tanımla, sonra ajanı bağla:

```bash
cd /opt/vpn-control-plane
npm run node:add -- --region de-fra --display "Frankfurt" \
  --endpoint vpn.senin-domain.com:51820 \
  --public-key "$(sudo cat /etc/wireguard/server_public.key)" \
  --pool 10.8.0.0/24 --default

# Docker kullanıyorsan aynı komut:
docker compose exec api node scripts/add-node.mjs --region de-fra \
  --display "Frankfurt" --endpoint vpn.senin-domain.com:51820 \
  --public-key "$(sudo cat /etc/wireguard/server_public.key)" \
  --pool 10.8.0.0/24 --default
```

Token bir kez basılıyor. Node'da:

```bash
sudo install -m 755 vpn-node-agent /usr/local/bin/
sudo tee /etc/vpn-node-agent.env >/dev/null <<'EOF'
VPN_CONTROL_PLANE=https://api.senin-domain.com
VPN_NODE_TOKEN=<node:add ciktisindaki token>
VPN_INTERFACE=wg0
EOF
sudo chmod 600 /etc/vpn-node-agent.env
sudo cp deploy/vpn-node-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vpn-node-agent
```

Docker ile de çalıştırılabilir ama **systemd tercih edilmeli.** Ajan `wg0`'ı
görmek için host ağını, değiştirmek için `CAP_NET_ADMIN`'i istiyor; ikisi
birlikte container'a systemd unit'iyle aynı erişimi veriyor, unit'in
sandbox'ı (`ProtectSystem`, `ProtectKernelTunables`, `RestrictNamespaces`)
olmadan. Yine de gerekiyorsa:

```bash
cp vpnd/.env.example vpnd/.env    # token'ı yapıştır
docker compose --profile agent up -d agent
```

**Doğrula:**

```bash
sudo journalctl -u vpn-node-agent -n 20    # "peers reconciled" gormeli
curl -s https://api.senin-domain.com/ready | jq '.nodes'
```

`online: false` ise ajan API'ye ulaşamıyor. `agentProvisioned: false` ise token
hiç üretilmemiş.

Zincirin tamamı ayakta, şimdi uçtan uca:

`ash
node scripts/acceptance.mjs https://api.senin-domain.com --check-wg
`

`--check-wg` sunucunun *kendisinde* çalıştırıldığında cihaz oluşturup
anahtarın `wg show`'da **belirmesini bekliyor** — API, veritabanı, ajan ve
`wg` zincirinin tamamını sınıyor. Mock ile test edilemeyen tek şey bu.
Rotasyonun tersini de doğruluyor: eski anahtarın interface'ten **çıktığını**.

Betik kendi hesaplarını açıp siliyor, production'da güvenli. Rate limiter'ı da
denemek istersen `--rate-limits` ekle — **çalıştırdığın IP'yi 15 dakika
kilitler**.

## 4. Mobil istemci

```bash
cd apps/client
flutter run --release --dart-define=API_BASE_URL=https://api.senin-domain.com
```

**Doğrula:** telefonda bağlan, sonra VPS'te:

```bash
sudo wg show wg0 latest-handshakes    # sıfırdan farklı bir zaman damgası
sudo wg show wg0 transfer             # iki yönde de bayt
```

Telefonda `whatismyip` → VPS'in IP'si görünmeli.

Linux/macOS istemcide daha ayrıntılısı için:

```bash
./server/scripts/verify-tunnel.sh --expect-ip <VPS-IP>
```

Bu, el yordamıyla fark edilmesi zor üç şeyi kontrol eder: **IPv6 sızıntısı**
(IPv4-only tünelde klasik), DNS'in nereye gittiği, ve MTU (ping çalışırken
HTTPS'in takılması).

## 5. Masaüstü istemci

```bash
# Linux
sudo install -m 755 vpnd /usr/local/bin/vpnd
sudo groupadd -f vpn && sudo usermod -aG vpn "$USER"   # sonra oturumu kapat/aç
sudo cp deploy/vpnd.service /etc/systemd/system/
sudo systemctl enable --now vpnd

# Windows (yönetici PowerShell)
.\deploy\install-windows.ps1 -BinaryPath .\bin\vpnd.exe
```

**Doğrula:**

```bash
./scripts/verify-daemon.sh                 # Linux/macOS
.\scripts\verify-daemon.ps1                # Windows
```

Bu betik en önemli iki şeyi ayrıca dener: soketin **TCP'de dinlemediğini**, ve
`PostUp` içeren bir config'in **reddedildiğini**. İkincisi gerçekten dosya
yazmayı dener — çalışsaydı root/SYSTEM olarak kod çalıştırılmış olurdu.

## 6. Tarayıcı eklentisi

[extension/README.md](../extension/README.md) — eklenti ID'sini alıp native
host manifest'ine yazmak ve Chrome'u yeniden başlatmak gerekiyor.

**Doğrula:** rozet `ON` göstermeli, popup'tan Disconnect çalışmalı.

## 7. Web dashboard ve indirme sayfası

```bash
cd apps/dashboard && flutter build web --release
# build/web'i Caddy'nin servis ettiği dizine kopyala
```

Dashboard `API_BASE_URL` boş bırakılırsa same-origin çalışır — Caddy hem
sayfayı servis edip hem `/auth` ve `/devices`'ı proxy'liyorsa hiçbir ayar
gerekmez ve CORS'a hiç girilmez.

---

## Bir şey ters giderse

| Belirti | Bakılacak yer |
|---|---|
| "connecting" sonsuza kadar | `sudo wg show wg0 latest-handshakes` — sıfırsa anahtar sunucuda yok |
| Handshake var, internet yok | `verify-deploy.sh` → forwarding ve MASQUERADE |
| Ping çalışıyor, HTTPS takılıyor | MTU. `WG_CLIENT_MTU=1380` dene |
| IP değişmedi | `verify-tunnel.sh` → AllowedIPs muhtemelen `0.0.0.0/0` değil |
| Masaüstünde "service is not running" | `verify-daemon.sh` — servis mi, soket izni mi, protokol mü |
| Herkes aynı anda 429 alıyor | `TRUST_PROXY` proxy sayısıyla eşleşmiyor |
| Cihaz eklendi ama tünel kurulmuyor | Ajan çalışmıyor: `journalctl -u vpn-node-agent` |
| `/ready` 503 | Hiçbir ajan sync etmemiş |
