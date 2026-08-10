# Kopmalar ve yavaşlık

Üç ayrı belirti, üç ayrı sebep. Karıştırılırsa yanlış yerde saatler harcanır.

| Belirti | Sebep | Nerede çözülür |
|---|---|---|
| Bağlanıyor ama bazı siteler açılmıyor / HTTPS takılıyor, ping çalışıyor | **MTU** | İstemci config'i |
| Bir süre kullanmayınca kopuyor, tekrar açınca düzeliyor | **NAT zaman aşımı** | `PersistentKeepalive` |
| Hızlı ama kekeliyor, yük altında paket kaybı | **Kernel buffer'ları** | Sunucu sysctl |

## 1. MTU — "ping çalışıyor, HTTPS takılıyor"

En sık ve en yanıltıcı olan. Küçük paketler geçiyor, büyük paketler geçmiyor.
Yol üzerindeki bir router "fragmentation needed" ICMP'si göndermeli ama
internetin büyük kısmında ICMP filtreleniyor, dolayısıyla o mesaj hiç
ulaşmıyor. Tünel ayakta görünüyor ve iş görmüyor.

**Varsayılanımız 1420** (`WG_CLIENT_MTU`) ve 1500'lük normal bir yol için
doğru. Ama yol 1500 değilse düşürmek gerekir:

| Erişim tipi | Yol MTU | Önerilen |
|---|---|---|
| Normal ethernet/fiber | 1500 | 1420 |
| PPPoE (çoğu DSL) | 1492 | 1412 |
| Bazı mobil şebekeler / CGNAT | 1400–1450 | 1380 |
| Üstüne başka tünel varsa | değişken | 1280 (IPv6 tabanı, her yerde geçer) |

Doğru değeri tahmin etme, **ölç**. İstemcide bağlıyken:

```bash
./server/scripts/verify-tunnel.sh --expect-ip <VPS-IP>
```

Betik parçalanmaya izin vermeden büyük paket gönderiyor. Elle bakmak istersen:

```bash
# Geçen en büyük payload'ı bul; MTU = bulunan + 28
ping -M do -s 1372 -c 2 1.1.1.1   # 1372 + 28 = 1400
```

`WG_CLIENT_MTU`'yu değiştirip control plane'i yeniden başlatmak yeterli —
istemciler bir sonraki config çekişinde alır.

> Bunu tek bir kullanıcı için değil, kullanıcı tabanının en kötü yolu için
> ayarla. 1380 herkeste çalışır ve iyi yollarda kaybı yüzde birin altındadır;
> 1420 kötü yollarda tamamen bozulur. Şüphedeysen düşür.

## 2. Kopmalar — NAT zaman aşımı

İstemci NAT arkasındayken (ev routerı, mobil) ve trafik yokken router UDP
eşleşmesini düşürüyor; sunucu artık istemciye ulaşamıyor. Kullanıcı bunu
"uygulamayı açınca düzeliyor" diye tarif eder.

**`PersistentKeepalive = 25`** bunu çözüyor ve bizde varsayılan.
25 saniye keyfi değil: sahadaki en agresif UDP NAT zaman aşımları 30 saniye
civarında kümeleniyor, 25 onun altında kalan en büyük yuvarlak değer.

Hâlâ kopuyorsa NAT alışılmadık derecede agresif demektir — `WG_PERSISTENT_KEEPALIVE=15`
dene. Daha aşağı inmenin anlamı yok, sadece pil ve veri harcar.

Keepalive **istemci tarafında** olmalı, sunucuda değil: NAT arkasında olan
taraf o. Bizim ürettiğimiz `.conf` zaten istemci config'i, doğru yerde.

**WireGuard roaming'i kendi hallediyor:** istemci wifi'dan mobile geçtiğinde
sunucu, doğrulanmış ilk paketten endpoint'i güncelliyor. Bunun için ayar yok
ve gerekmiyor.

## 3. Yük altında paket kaybı — kernel buffer'ları

Varsayılan `rmem_max` çoğu dağıtımda ~212 KB. Bu, WireGuard şifre çözerken
gelen paket patlamasını tutmaya yetmiyor: kernel paketleri **WireGuard onları
görmeden** düşürüyor. Kullanıcıda "hızlı ama kekeliyor" olarak görünür.

`setup-wg.sh` artık bunları yazıyor (`/etc/sysctl.d/99-wireguard.conf`):

```
net.core.rmem_max = 16777216        # 212 KB -> 16 MB
net.core.wmem_max = 16777216
net.core.netdev_max_backlog = 5000  # NIC ile kernel arasındaki kuyruk
net.core.netdev_budget = 600        # tek NAPI turunda işlenecek paket
net.netfilter.nf_conntrack_max = 262144
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
```

**conntrack özellikle önemli:** NAT kuralı yüzünden tünellenen her akış bir
conntrack yuvası tutuyor. Varsayılan tablo sessizce doluyor ve dolduğunda yeni
bağlantılar rastgele başarısız oluyor — kullanıcı bunu "bazen açılmıyor" diye
tarif eder, ki teşhis etmesi en zor belirti.

Doluluğu izle:

```bash
sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
```

**BBR**, VPN'in ürettiği uzun ve kayıplı yollarda cubic'ten belirgin şekilde
iyi. Kernel'de `tcp_bbr` yoksa script uyarı verip devam ediyor.

## Neyi ölçmeli

```bash
sudo ./server/scripts/verify-deploy.sh      # sysctl, NAT, forwarding
./server/scripts/verify-tunnel.sh --expect-ip <VPS-IP>   # MTU, sızıntı, handshake
sudo wg show wg0 transfer                   # iki yönde de bayt akıyor mu
sudo wg show wg0 latest-handshakes          # 180sn'den eskiyse sorun var
```

Trafik akarken WireGuard yaklaşık iki dakikada bir yeniden el sıkışıyor. Son
el sıkışma 3 dakikadan eskiyse ya tünel boşta ya da peer'a ulaşılamıyor.
