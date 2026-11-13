import { handlers } from "@/auth";

// A stalled pool retries for ~22s; the platform default (15s) would 504
// first. Explicit ceiling so retries get to finish.
export const maxDuration = 30;


export const { GET, POST } = handlers;
