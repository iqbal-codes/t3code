import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OmpSettings } from "./settings.ts";

const lightInk = { light: "#0d0d0d", dark: "#fafafa" };
const connector = { light: "#f97316", dark: "#f97316" };
const connectorInk = { light: "#0d0d0d", dark: "#0d0d0d" };

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "omp",
  badgeLabel: "Early Access",
  settingsSchema: OmpSettings,
  icon: {
    viewBox: "0 0 120 90",
    fill: lightInk,
    paths: [
      { d: "M12 8H108A2 2 0 0 1 110 10V18A2 2 0 0 1 108 20H12A2 2 0 0 1 10 18V10A2 2 0 0 1 12 8Z" },
      { d: "M27 20H35A2 2 0 0 1 37 22V80A2 2 0 0 1 35 82H27A2 2 0 0 1 25 80V22A2 2 0 0 1 27 20Z" },
      { d: "M77 20H85A2 2 0 0 1 87 22V63A2 2 0 0 1 85 65H77A2 2 0 0 1 75 63V22A2 2 0 0 1 77 20Z" },
      {
        d: "M74 55H88A3 3 0 0 1 91 58V68A3 3 0 0 1 88 71H74A3 3 0 0 1 71 68V58A3 3 0 0 1 74 55Z",
        fill: connector,
      },
      { d: "M76 59H79V67H76Z", fill: connectorInk },
      { d: "M82 59H85V67H82Z", fill: connectorInk },
      { d: "M20 14A2 2 0 1 1 16 14A2 2 0 1 1 20 14Z", fill: connector },
      { d: "M104 14A2 2 0 1 1 100 14A2 2 0 1 1 104 14Z", fill: connector },
    ],
  },
});
