import type { AuthConfig } from "convex/server";
import { env } from "./_generated/server";

const authConfig = {
  providers: [
    {
      domain: env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;

export default authConfig;
