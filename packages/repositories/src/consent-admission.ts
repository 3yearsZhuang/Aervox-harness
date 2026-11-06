/** The existing local consent owner: one unrevoked grant per purpose/scope. */
import { and, eq, isNull } from "drizzle-orm";
import { consentGrants } from "@aervox/schema";

export const activeConsentPredicate = (purpose: string, scope: string) => and(
  eq(consentGrants.purpose, purpose), eq(consentGrants.scope, scope), isNull(consentGrants.revokedAt),
);
