import { liveApi } from "./client";
import { mockApi } from "./mock";

/** Production builds always call the real API; `npm run dev` uses mocks unless VITE_API_MODE=live. */
export const API_MODE: "mock" | "live" = import.meta.env.PROD || import.meta.env.VITE_API_MODE === "live" ? "live" : "mock";
export const api = API_MODE === "live" ? liveApi : mockApi;
export * from "./types";
export { ApiError, errorMessage, timed } from "./client";
