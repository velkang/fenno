// Static assets and the SPA fallback are served before this code runs; only the
// `run_worker_first` API paths reach it. Forwarding them over a service binding
// keeps the session cookie first-party on the web host.
type Env = { API: { fetch(request: Request): Promise<Response> } };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return env.API.fetch(request);
  },
};
