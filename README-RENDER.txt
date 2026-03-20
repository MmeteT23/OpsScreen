# Render için hazır proje

## İçindekiler
- server.js -> Render uyumlu sürüm
- admin.html
- index.html
- script.js
- style.css
- package.json
- render.yaml

## Render'da yayınlama
1. Bu dosyaları GitHub repona yükle.
2. Render'da **New > Web Service** seç.
3. GitHub reponu bağla.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Environment Variables kısmında:
   - `ADMIN_USER` = istediğin kullanıcı adı
   - `ADMIN_PASS` = istediğin şifre

## Not
- Render'ın dosya sistemi kalıcı değildir.
- Yüklenen medya ve JSON verileri servis yeniden başlarsa sıfırlanabilir.
- Kalıcı medya istersen sonraki adımda Cloudinary / database eklenmeli.
