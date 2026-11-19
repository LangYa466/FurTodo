// Optional secrets: `secrets.required` in wrangler.jsonc only covers required
// ones, so their types are declared here.

interface Env {
  /**
   * Fine-grained PAT with FurDevsCN "Members: read", used when the org's OAuth
   * app restrictions hide membership from the user's own token.
   */
  GITHUB_ORG_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env {
    GITHUB_ORG_TOKEN?: string;
  }
}
