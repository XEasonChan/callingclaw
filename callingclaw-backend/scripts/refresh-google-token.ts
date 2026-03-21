#!/usr/bin/env bun
// Temporary script to refresh Google OAuth token
// Usage: bun scripts/refresh-google-token.ts

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3939/callback";
const SCOPE = "https://www.googleapis.com/auth/calendar";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env");
  process.exit(1);
}

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

console.log("\n🔐 Opening browser for Google authorization...\n");
Bun.spawn(["open", authUrl]);

// Start temporary callback server
const server = Bun.serve({
  port: 3939,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("No code received. Try again.", { status: 400 });
      }

      // Exchange code for tokens
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID!,
          client_secret: CLIENT_SECRET!,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      });

      const data = await tokenRes.json() as any;

      if (data.error) {
        console.error("\n❌ Token exchange failed:", data.error, data.error_description);
        setTimeout(() => process.exit(1), 100);
        return new Response(`Error: ${data.error_description}`, { status: 400 });
      }

      console.log("\n✅ New tokens received!");
      console.log("   Refresh token:", data.refresh_token);
      console.log("   Access token:", data.access_token?.slice(0, 20) + "...");
      console.log("   Expires in:", data.expires_in, "seconds");

      // Update .env file
      if (data.refresh_token) {
        const envPath = `${import.meta.dir}/../.env`;
        const envFile = Bun.file(envPath);
        let envContent = await envFile.text();
        envContent = envContent.replace(
          /^GOOGLE_REFRESH_TOKEN=.*$/m,
          `GOOGLE_REFRESH_TOKEN=${data.refresh_token}`
        );
        await Bun.write(envPath, envContent);
        console.log("\n📝 Updated .env with new refresh token");

        // Also update the OpenClaw token file
        const tokenPath = `${process.env.HOME}/.openclaw/workspace/google-token.json`;
        const tokenFile = Bun.file(tokenPath);
        if (await tokenFile.exists()) {
          const existing = await tokenFile.json() as any;
          existing.refresh_token = data.refresh_token;
          await Bun.write(tokenPath, JSON.stringify(existing, null, 2));
          console.log("📝 Updated ~/.openclaw/workspace/google-token.json");
        }
      }

      console.log("\n🔄 Now restart CallingClaw to use the new token.");
      setTimeout(() => process.exit(0), 500);
      return new Response(
        "<html><body><h1>✅ Token refreshed!</h1><p>You can close this tab. Restart CallingClaw to use the new token.</p></body></html>",
        { headers: { "Content-Type": "text/html" } }
      );
    }
    return new Response("Waiting for OAuth callback...", { status: 200 });
  },
});

console.log(`Callback server listening on http://localhost:3939`);
console.log("Waiting for authorization...\n");
