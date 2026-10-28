# Deploying on EC2 (Ubuntu 22.04/24.04)

Processes: `shorts-api` (Express, port 5000) and `shorts-worker` (BullMQ) under PM2, behind Nginx.
External: MongoDB (Atlas recommended), Redis (local or ElastiCache), S3 bucket.

## 1. Instance
- t3.small or larger (ffmpeg + 200 MB downloads; 2 GB RAM minimum), 20+ GB disk.
- Security group: inbound 22 (your IP only), 80, 443. **Do not open 5000, 6379 or 27017.**
- Atlas: add the EC2 Elastic IP to the Atlas network allowlist.
- S3 access: prefer an IAM role on the instance; the app currently reads `AWS_KEY`/`AWS_SECRET` from `.env`.

## 2. Install
```bash
sudo apt update && sudo apt install -y nginx redis-server git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2
sudo systemctl enable --now redis-server   # binds to localhost by default; skip if using ElastiCache
```

## 3. App
```bash
git clone -b deploy-ec2 https://github.com/Shivanshu-Tyagi/shorts.git && cd shorts
npm ci --omit=dev
cp .env.example .env && nano .env
```
Production values to set in `.env`:
- `NODE_ENV=production`, `MONGO_URL` (Atlas URI), `REDIS_URL=redis://localhost:6379`
- `AWS_KEY/AWS_SECRET/AWS_REGION/BUCKET/CDN_DOMAIN`, `RAPID_API_KEY`, `RAPID_API_HOST`
- `TRUST_PROXY=1` (required behind Nginx or per-IP rate limits see 127.0.0.1)
- `METRICS_TOKEN`, `ADMIN_TOKEN` (long random strings; leave unset to disable those endpoints)
- `ALLOW_CLIENT_REWARD_VERIFICATION=false`
- Remove the inline `# comments` after values if your `.env` parser complains (dotenv 17 handles them, but keep values clean).

Firebase key (gitignored, so copy it from your machine):
```bash
scp -i key.pem src/config/firebase-key.json ubuntu@<ec2-ip>:~/shorts/src/config/
```

Indexes (once, then optionally set `MONGO_AUTO_INDEX=false`):
```bash
npm run db:ensure-indexes
```

## 4. Run
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd     # run the command it prints, then `pm2 save` again
curl localhost:5000/health
```

## 5. Nginx + HTTPS
`/etc/nginx/sites-available/shorts`:
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/shorts /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```
Point the domain's A record at the instance's Elastic IP first.

## 6. Updates
```bash
cd ~/shorts && git pull && npm ci --omit=dev && pm2 reload ecosystem.config.js
```

## Notes
- CORS origins are hardcoded in `src/app.js`; add your domain there if a browser client calls the API.
- Logs: `pm2 logs`; install rotation with `pm2 install pm2-logrotate`.
- Run only one `shorts-api` instance unless you move the notification cron out of the API process.
