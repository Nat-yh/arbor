import { DEMO_PEOPLE } from "./demo-people";

export const localAuthEnabled = () => process.env.LOCAL_AUTH_ENABLED === "true";
export const demoEnabled = () => process.env.DEMO_MODE === "true" && !localAuthEnabled();
export const accountCodePattern = /^[a-f0-9]{64}$/;

const demoIds = new Set([...DEMO_PEOPLE.map(({ id }) => id), "guest"]);
export const isDemoIdentity = (id: string) => demoIds.has(id);
