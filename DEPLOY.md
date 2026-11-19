# Deploy FloodWatch on Render

## First deployment: free website preview

1. Create a Render account at https://dashboard.render.com/register and sign in.
2. Create a **private GitHub repository** named `floodwatch`. Upload the extracted contents of `floodwatch-render-deploy.zip` into the repository root. You should see `render.yaml`, `server.js`, `package.json`, `public/` and `data/` directly at its root. Upload the extracted files, not the ZIP file. The package intentionally omits `.env`, cached weather and subscriber records.
3. In Render choose **New → Blueprint**, connect the repository, and select its `render.yaml`.
4. Enter `WEATHERAPI_KEY` when Render prompts. Get it from your existing private local `.env`; do not commit `.env` or put the key in a public file. Keep all other variables from the blueprint. It explicitly selects the **Free** service plan and disables SMS. Review Render's displayed costs and limits before creating anything.
5. Deploy. Render assigns an HTTPS `onrender.com` URL; no purchased domain is needed. The root URL opens the atlas design. The monitoring dashboard remains at `/index.html`.
6. Check `/api/health`, search for Lucknow in the atlas, then let the national forecast finish loading. A cold forecast scan takes time. IMD access remains subject to its permissions, and individual external feeds can still be unavailable.

Free hosting is for the website preview. It may sleep after inactivity and resets local files on restarts/deployments. **It cannot provide reliable unattended SMS or durable subscriptions.** Do not add SMS credentials to this tier.

## Later: enable automatic SMS after approving paid hosting

Keep the service at one instance. Upgrade to an always-on paid instance and attach a 1 GB persistent disk at `/var/data`. Set `STORAGE_DIR=/var/data`. In the repository blueprint, change `plan` to the paid plan selected in Render and add the disk before future blueprint syncs:

```yaml
    disk:
      name: floodwatch-storage
      mountPath: /var/data
      sizeGB: 1
```

The service's forecast cache and private subscriber file will then live on this disk. Source CSVs stay in `data/` in the deployment source. Do not mount a disk over that source directory or inside `public/`.

Add the Twilio account SID, auth token and sender number to Render's private environment settings. Set `SMS_ENABLED=true`. The backend uses Render's generated HTTPS URL automatically for unsubscribe links; set `PUBLIC_BASE_URL` only if using your own domain. Configure the optional inbound Twilio webhook at `/api/sms/inbound`. Redeploy and confirm `/api/sms/status` reports `configured: true`, then verify an authorized phone number through the signup form. Provider acceptance is not proof of delivery; check the recipient handset and Twilio delivery status.

Hosting charges and WeatherAPI/Twilio usage charges are separate. Review the provider's account requirements and current rates before activation.

Official references: [Render free tier](https://render.com/docs/free), [Blueprints](https://render.com/docs/blueprint-spec), [persistent disks](https://render.com/docs/disks).
