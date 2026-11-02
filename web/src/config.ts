// Where the API lives. One declaration, imported everywhere.
//
// import.meta.env.VITE_API_URL is substituted by Vite at BUILD time, not read
// at runtime — so a production build bakes in the production API and the dev
// build keeps localhost, with no branching in application code.
//
// The VITE_ prefix is a safety rail, not a convention: Vite refuses to expose
// any other env var to the bundle. Everything in a client bundle is public, so
// it forces you to opt in deliberately rather than leaking DATABASE_URL into
// JavaScript the whole internet can read.
export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";