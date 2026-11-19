# FloodWatch live map backend

This is a small Node.js backend and static-site package for the FloodWatch prototype. It serves the page, proxies IMD district warnings/rainfall, and fetches WeatherAPI district forecasts from the server so the WeatherAPI key stays out of browser code.

## Run locally

1. Install Node.js 24 or newer.
2. Copy `.env.example` to `.env`. Set `WEATHERAPI_KEY` to your WeatherAPI key there. Keep `.env` private; it is ignored by Git and is intentionally excluded from the download bundle.
3. Run `npm start` from this folder and open `http://localhost:3000`.

The start command uses Node's `--use-system-ca` option so the official BBMB site's certificate chain can be validated against the operating system's trusted certificate store. TLS verification remains enabled. If a deployment host cannot validate that chain, the reservoir section reports the source as unavailable.

## Monitoring dashboard

The turquoise cartoon theme includes an animated SVG lookout, clouds, rain and river. **Pause animation** persists a browser-local preference; the theme also honors the system's reduced-motion preference.

The top automatic watch ranks the entire returned national snapshot: high/elevated screening first, then rain watches with at least 70% daily rain chance and positive forecast rainfall. Percentages are precipitation probabilities, not flood probabilities. Incomplete, failed or stale national scans do not generate new national notifications. Fresh high/elevated national watches join selected-district notifications when browser alerts are enabled. The server rechecks its national cache every five minutes while running and renews provider forecasts after the six-hour cache expires.

### Reservoir coverage

`GET /api/reservoirs` reads the public BBMB home-page reservoir table and exposes Bhakra and Pong water elevations (feet), inflow/outflow (cusecs), operator observation time, fetch time, and reference levels. Source: https://bbmb.gov.in/index.htm. Reference elevations: https://bbmb.gov.in/data-reservoir.htm. Bhakra FRL/MWL: 1680/1690 ft. Pong uses the published **reduced** FRL/MWL of 1390/1410 ft (design FRL is 1400 ft).

The source is checked at most every 30 minutes; this does not imply the operator publishes every 30 minutes. Data older than 36 hours, an unknown/future publication date, or a fetch failure is labeled stale/unavailable and generates no new reservoir risk alert. A fresh reading within 5 ft of FRL triggers a custom app watch; at/above FRL or MWL triggers review of official operating advisories. These thresholds are not operator-issued warnings. No storage percentage is inferred from elevation.

Only two BBMB reservoirs are integrated. For wider published reservoir information, the UI links to the CWC RSMS portal: https://rsms.cwc.gov.in/frameWork/web/public-dashboard. Its weekly storage bulletins are not a continuous structural-health or dam-breach feed. The implementation does not infer dam failure, confirm overtopping, or map downstream flooding from rainfall, storage or releases alone. That requires current operator advisories, operating rules, catchment/river observations and a validated downstream inundation model.

The home page is the monitoring dashboard; the original supplied-data view is preserved at `/atlas.html`.
Choose a district, a map marker, or **Use my location** to monitor the nearest covered forecast point. Geolocation coordinates stay in the browser. Only the selected district and state are sent to the backend and WeatherAPI.

`GET /api/monitor?district=...&state=...` fetches current provider weather, a three-day forecast including hourly rain, and available provider weather alerts. Requests for the same district share a five-minute cache and in-flight request. The browser checks this endpoint every five minutes while running, independently of the six-hour national map cache. Each distinct district monitored continuously can add about 8,640 provider requests per 30 days; budget for traffic and account limits before public deployment.

The **Enable browser alerts** button requests browser notification permission. New provider alerts and high/elevated screening watches generate an in-page alert; with permission and the toggle enabled, they also generate a browser notification. Repeated alerts are suppressed for the page session. No notification is generated for data whose provider observation is missing/older than 90 minutes or whose fetch is older than ten minutes. Failed requests display an interrupted status and retry. Browser permission was not enabled automatically.

Notifications require the page to keep running; this is not a closed-app push service. SMS uses the separately configured background worker described below. Persistent push delivery is not connected. No river gauge or water-level sensor feed is connected, and the interface marks this explicitly. The screening is not a validated flood prediction model.

## IMD access

IMD's published API documentation lists district warnings and district-wise rainfall endpoints. It does not document a general API key for these endpoints, but says a public IP must be provided for whitelisting for many feeds. Deploy this backend with a stable public egress IP and request IMD access/whitelisting for that IP if required. Until the feeds answer successfully, the map reports the connection issue instead of showing fabricated data.

The weather screen requests 3-day forecasts and provider weather alerts (`alerts=yes`) for the 439 supplied atlas district records. It caches them for six hours by default (about 52,700 location calls per 30-day month if every refresh succeeds) and limits concurrent requests. The page refreshes its alert view every five minutes, but provider data is refreshed when the six-hour server cache expires; each alert shows the time of its latest provider check. Alert availability depends on WeatherAPI plan and regional coverage. An empty alert feed means no alert was returned for the queried locations, not that flooding is impossible. WeatherAPI's Free plan currently lists a 3-day forecast and 100,000 calls/month; check your account's current quota before deployment. If the API key is restricted to browser domains, backend requests may be rejected; configure the key using the provider's supported server-side access restrictions rather than exposing it in the page.

The “High flood watch” and “Elevated watch” labels are a screening heuristic: forecast daily rainfall amount/chance combined with the supplied historical flood-affected area. They are not calibrated flood probabilities, official warnings, or a hydrological model. The screen does not model river level, soil saturation, reservoir releases, drainage, or all flood mechanisms. The application geocodes district names through WeatherAPI and plots the returned forecast coordinates; ambiguous or unmatched names are counted as skipped. Follow official IMD and local authority guidance.

The separate IMD district warning/rainfall endpoint remains available at `/api/live`; IMD currently returns HTTP 401 to the local backend until access is authorized. The dashboard shows feed availability and uses WeatherAPI provider alerts and forecast screening. A reachable IMD feed is not yet normalized into district notifications.

## Hosting

Deploy the whole folder as a Node.js service. Keep credentials in the hosting platform's server-side environment settings; never place secrets in `public/`. This backend serves the page and same-origin `/api/risk` and `/api/live` routes. Set `PORT` through the host if required. The default map tiles use OpenStreetMap's standard tile service and include attribution; follow its usage policy or choose a production tile provider for higher traffic.

### SMS alerts

Both the atlas (`/atlas.html#sms-signup`) and monitoring dashboard offer SMS registration. Registrants choose a covered district, consent to texts, and enter a six-digit verification code. A code expires after ten minutes, permits five guesses and has resend limits. A new request cannot change an already verified subscription until verification succeeds.

A dedicated server worker checks each distinct subscribed district every five minutes, including while the browser is closed. It uses fresh WeatherAPI forecasts and the existing high/elevated screening rules. Provider observations older than 90 minutes, future observations, missing current-date forecasts, failed requests and lower/watch signals generate no flood-watch SMS. This feature does not calculate a calibrated probability of flooding or issue official evacuation warnings.

Set these privately in `.env` or the host environment, then restart the service:

- `TWILIO_ACCOUNT_SID`: real account SID.
- `TWILIO_AUTH_TOKEN`: account credential.
- `TWILIO_FROM_NUMBER`: the account's SMS-capable sender in international format.
- `PUBLIC_BASE_URL`: the public HTTPS origin serving this app, used for unsubscribe links.
- `WEATHERAPI_KEY`: the existing forecast credential.

Until these are present, SMS registration is visibly unavailable. Use an always-running Node host with a persistent private disk and one service instance. Localhost delivery stops when the laptop or backend stops. Each monitored district can add roughly 8,640 forecast requests per 30 days; set provider spending limits for forecast and SMS usage. Account permissions, sender routing and recipient eligibility must be enabled in Twilio before messages can be delivered. Consult [Twilio message setup](https://www.twilio.com/docs/messaging/api/message-resource) and [India delivery guidelines](https://www.twilio.com/en-us/guidelines/in/sms) for the account's route requirements.

Private `.sms-subscribers.json` holds phone numbers, district, consent/verification timestamps, hashed codes, opt-out tokens and alert history. It must stay outside `public/`, backups and downloads shared with visitors. Writes and SMS operations are serialized. The worker reserves each event before requesting delivery to suppress duplicates across restarts. Each district/date/level is sent at most once; a higher level can bypass the one-hour cooldown. Provider acceptance is not confirmed handset delivery. Failed or ambiguous sends are stored as `unconfirmed` and are not automatically resent for that event, avoiding duplicate texts after timeouts; inspect the provider console and private history to investigate delivery failures.

Each alert includes a stable unsubscribe link, and verification shows a management link. Opt-out invalidates pending codes as well as stopping further sends. For senders/routes that support replies, configure the incoming Twilio webhook to `PUBLIC_BASE_URL/api/sms/inbound`; signed STOP messages are handled. The web unsubscribe link works independently of reply support. Subscriber storage errors stop registration and sending until repaired; malformed storage is never overwritten with an empty list.

### District exposure search

The full district exposure CSV is stored in the backend-only `data/district_exposure.csv` file and is not served as a public static asset. The browser bundle contains state summaries and other atlas context but not the district-level exposure rows. `GET /api/atlas/districts?q=<search>&state=<optional-state>` returns at most 12 matching atlas records for searches of two or more characters; an empty search can return state-filtered results only when a state is explicitly selected. The atlas starts with the table hidden and displays only matching records. District names and mapped exposure are historical atlas data, not current flood conditions.