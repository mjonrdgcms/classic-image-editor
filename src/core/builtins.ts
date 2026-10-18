/**
 * Every command the editor knows. Menus, tools and shortcuts dispatch these,
 * so they are also everything Actions and the AI can do.
 */

import { editCommands } from "./cmd/edit";
import { filterCommands, trackFilterState } from "./cmd/filters";
import { maskCommands } from "./cmd/masks";
import { layerCommands } from "./cmd/layers";
import { selectCommands } from "./cmd/select";
import { typeCommands } from "./cmd/type";
import { liquifyCommands } from "./cmd/liquify";
import { peopleCommands } from "./cmd/people";
import { faceSwapCommands } from "./cmd/faceswap";
import { imageCommands } from "./cmd/image";
import { transformCommands } from "./cmd/transform";
import { healCommands } from "./cmd/heal";
import { styleCommands } from "./cmd/styles";
import { annotateCommands } from "./cmd/annotate";
import { pathCommands } from "./cmd/paths";
import type { CommandBus, CommandDef } from "./commands";

export const builtinCommands: CommandDef[] = [...layerCommands, ...maskCommands, ...selectCommands, ...editCommands, ...filterCommands, ...typeCommands, ...liquifyCommands, ...peopleCommands, ...faceSwapCommands, ...imageCommands, ...transformCommands, ...healCommands, ...styleCommands, ...annotateCommands, ...pathCommands];

export function registerBuiltins(bus: CommandBus): void {
  for (const c of builtinCommands) bus.register(c);
  bus.onCommand((rec) => trackFilterState(bus, rec.name));
}
