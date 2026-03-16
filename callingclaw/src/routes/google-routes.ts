// CallingClaw 2.0 — Google OAuth / Credentials API Routes
// /api/google/scan, /api/google/apply, /api/google/set

import { scanForGoogleCredentials } from "../mcp_client/google_cal";
import type { Services, RouteHandler } from "./types";

const ENV_PATH = `${import.meta.dir}/../../../.env`;

export function googleRoutes(services: Services): RouteHandler {
  return {
    match: (pathname, method) => pathname.startsWith("/api/google/"),

    handle: async (req, url, headers) => {
      // GET /api/google/scan — Scan local filesystem for Google OAuth credentials
      if (url.pathname === "/api/google/scan" && req.method === "GET") {
        const result = await scanForGoogleCredentials();
        return Response.json(
          {
            found: !!result.credentials,
            sources: result.sources,
            credentials: result.credentials
              ? {
                  clientId: `${result.credentials.clientId.slice(0, 12)}...`,
                  refreshToken: `${result.credentials.refreshToken.slice(0, 12)}...`,
                  hasSecret: true,
                }
              : null,
          },
          { headers }
        );
      }

      // POST /api/google/apply — Apply scanned credentials (write to .env and connect)
      if (url.pathname === "/api/google/apply" && req.method === "POST") {
        const { credentials } = await scanForGoogleCredentials();
        if (!credentials) {
          return Response.json(
            { error: "No Google credentials found on this machine" },
            { status: 404, headers }
          );
        }

        const envFile = Bun.file(ENV_PATH);
        let envContent = (await envFile.exists()) ? await envFile.text() : "";

        const updates: Record<string, string> = {
          GOOGLE_CLIENT_ID: credentials.clientId,
          GOOGLE_CLIENT_SECRET: credentials.clientSecret,
          GOOGLE_REFRESH_TOKEN: credentials.refreshToken,
        };

        for (const [key, value] of Object.entries(updates)) {
          const regex = new RegExp(`^${key}=.*$`, "m");
          if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
          } else {
            envContent += `\n${key}=${value}`;
          }
        }

        await Bun.write(ENV_PATH, envContent);

        services.calendar.setCredentials(credentials);
        await services.calendar.connect();

        return Response.json(
          {
            ok: true,
            message: "Google credentials applied and calendar connected",
            connected: services.calendar.connected,
          },
          { headers }
        );
      }

      // POST /api/google/set — Manually set Google OAuth credentials
      if (url.pathname === "/api/google/set" && req.method === "POST") {
        const body = (await req.json()) as {
          client_id: string;
          client_secret: string;
          refresh_token: string;
        };

        if (!body.client_id || !body.client_secret || !body.refresh_token) {
          return Response.json(
            { error: "Missing required fields: client_id, client_secret, refresh_token" },
            { status: 400, headers }
          );
        }

        const envFile = Bun.file(ENV_PATH);
        let envContent = (await envFile.exists()) ? await envFile.text() : "";

        const updates: Record<string, string> = {
          GOOGLE_CLIENT_ID: body.client_id,
          GOOGLE_CLIENT_SECRET: body.client_secret,
          GOOGLE_REFRESH_TOKEN: body.refresh_token,
        };

        for (const [key, value] of Object.entries(updates)) {
          const regex = new RegExp(`^${key}=.*$`, "m");
          if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
          } else {
            envContent += `\n${key}=${value}`;
          }
        }

        await Bun.write(ENV_PATH, envContent);

        services.calendar.setCredentials({
          clientId: body.client_id,
          clientSecret: body.client_secret,
          refreshToken: body.refresh_token,
        });
        await services.calendar.connect();

        return Response.json(
          {
            ok: true,
            message: "Google credentials saved and calendar connected",
            connected: services.calendar.connected,
          },
          { headers }
        );
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    },
  };
}
