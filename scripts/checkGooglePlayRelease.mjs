import { GoogleAuth } from 'google-auth-library';

const packageName = process.argv[2] ?? 'com.mealwizard.app';
const track = process.argv[3] ?? 'internal';
const auth = new GoogleAuth({
  keyFile: './pc-api-google-play.json',
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});
const client = await auth.getClient();
const token = await client.getAccessToken();
const response = await fetch(
  `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/tracks/${encodeURIComponent(track)}/releases`,
  { headers: { authorization: `Bearer ${token.token}` } },
);

if (!response.ok) {
  throw new Error(`Google Play release lookup failed with HTTP ${response.status}`);
}

const payload = await response.json();
console.log(JSON.stringify(payload, null, 2));
