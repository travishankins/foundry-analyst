// Holds whoever is signed in and attaches their credentials to every API call.
// mock mode: a demo persona header (no real security). entra mode: an MSAL access token for the API scope.

const DEMO_KEY = 'foundry-demo.user';

let provider = async () => ({});

export const setAuthProvider = (fn) => {
  provider = fn;
};

export const authHeaders = () => provider();

export const getStoredDemoUser = () => localStorage.getItem(DEMO_KEY);
export const storeDemoUser = (id) => (id ? localStorage.setItem(DEMO_KEY, id) : localStorage.removeItem(DEMO_KEY));

export const demoProvider = (id) => async () => (id ? { 'X-Demo-User': id } : {});

/** Creates the MSAL client lazily so mock-mode users never download it. */
export async function createEntraSession({ tenantId, clientId, scope }) {
  const { PublicClientApplication } = await import('@azure/msal-browser');
  const app = new PublicClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, redirectUri: window.location.origin },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await app.initialize();
  const redirectResult = await app.handleRedirectPromise();
  const account = redirectResult?.account ?? app.getActiveAccount() ?? app.getAllAccounts()[0] ?? null;
  if (account) app.setActiveAccount(account);

  const token = async () => {
    const active = app.getActiveAccount();
    try {
      return (await app.acquireTokenSilent({ scopes: [scope], account: active })).accessToken;
    } catch {
      await app.acquireTokenRedirect({ scopes: [scope], account: active });
      return null;
    }
  };

  return {
    signedIn: Boolean(account),
    signIn: () => app.loginRedirect({ scopes: [scope] }),
    signOut: () => app.logoutRedirect({ account: app.getActiveAccount() }),
    provider: async () => {
      const accessToken = await token();
      return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    },
  };
}
