import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    OPENAI_API_KEY: v.string(),
    CLERK_JWT_ISSUER_DOMAIN: v.string(),
  },
});
