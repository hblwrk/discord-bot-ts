export type SlashRegistrationDiff = {
  expectedCommandNames: string[];
  returnedCommandNames: string[];
  missingCommandNames: string[];
  unexpectedCommandNames: string[];
  changedCommandNames: string[];
  truncated: boolean;
};

type CanonicalSlashCommandChoice = {
  name: string;
  value: unknown;
};

type CanonicalSlashCommandOption = {
  type: number;
  name: string;
  description: string;
  required: boolean;
  autocomplete: boolean;
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  channel_types: number[];
  choices: CanonicalSlashCommandChoice[];
  options: CanonicalSlashCommandOption[];
};

type CanonicalSlashCommand = {
  type: number;
  name: string;
  description: string;
  options: CanonicalSlashCommandOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value;
}

function toCanonicalSlashCommandChoice(choice: unknown): CanonicalSlashCommandChoice {
  if (!isRecord(choice)) {
    return {
      name: "",
      value: "",
    };
  }

  return {
    name: "string" === typeof choice["name"] ? choice["name"] : "",
    value: choice["value"],
  };
}

function toCanonicalSlashCommandOption(option: unknown): CanonicalSlashCommandOption {
  if (!isRecord(option)) {
    return {
      type: 0,
      name: "",
      description: "",
      required: false,
      autocomplete: false,
      channel_types: [],
      choices: [],
      options: [],
    };
  }

  const canonicalOption: CanonicalSlashCommandOption = {
    type: Number(option["type"] ?? 0),
    name: "string" === typeof option["name"] ? option["name"] : "",
    description: "string" === typeof option["description"] ? option["description"] : "",
    required: true === option["required"],
    autocomplete: true === option["autocomplete"],
    channel_types: Array.isArray(option["channel_types"])
      ? option["channel_types"].map((channelType: unknown) => Number(channelType))
      : [],
    choices: Array.isArray(option["choices"])
      ? option["choices"].map(toCanonicalSlashCommandChoice)
      : [],
    options: Array.isArray(option["options"])
      ? option["options"].map(toCanonicalSlashCommandOption)
      : [],
  };

  if ("number" === typeof option["min_value"]) {
    canonicalOption.min_value = option["min_value"];
  }

  if ("number" === typeof option["max_value"]) {
    canonicalOption.max_value = option["max_value"];
  }

  if ("number" === typeof option["min_length"]) {
    canonicalOption.min_length = option["min_length"];
  }

  if ("number" === typeof option["max_length"]) {
    canonicalOption.max_length = option["max_length"];
  }

  return canonicalOption;
}

function toCanonicalSlashCommand(command: unknown): CanonicalSlashCommand {
  if (!isRecord(command)) {
    return {
      type: 1,
      name: "",
      description: "",
      options: [],
    };
  }

  return {
    type: Number(command["type"] ?? 1),
    name: "string" === typeof command["name"] ? command["name"] : "",
    description: "string" === typeof command["description"] ? command["description"] : "",
    options: Array.isArray(command["options"])
      ? command["options"].map(toCanonicalSlashCommandOption)
      : [],
  };
}

function normalizeSlashCommandPayload(slashCommands: unknown): CanonicalSlashCommand[] {
  if (false === Array.isArray(slashCommands)) {
    return [];
  }

  return slashCommands
    .map(toCanonicalSlashCommand)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getSlashCommandPayloadHash(slashCommands: unknown): string {
  return JSON.stringify(normalizeSlashCommandPayload(slashCommands));
}

export function getSlashCommandNamesFromPayload(slashCommands: unknown): string[] {
  return normalizeSlashCommandPayload(slashCommands)
    .map(command => command.name)
    .filter(commandName => "" !== commandName);
}

export function computeSlashRegistrationDiff(expectedSlashCommands: unknown, returnedSlashCommands: unknown): SlashRegistrationDiff {
  const expectedCommands = normalizeSlashCommandPayload(expectedSlashCommands);
  const returnedCommands = normalizeSlashCommandPayload(returnedSlashCommands);
  const expectedCommandNames = expectedCommands.map(command => command.name);
  const returnedCommandNames = returnedCommands.map(command => command.name);
  const expectedCommandHashes = new Map<string, string>();
  const returnedCommandHashes = new Map<string, string>();

  for (const command of expectedCommands) {
    expectedCommandHashes.set(command.name, JSON.stringify(command));
  }

  for (const command of returnedCommands) {
    returnedCommandHashes.set(command.name, JSON.stringify(command));
  }

  const expectedCommandNameSet = new Set(expectedCommandNames);
  const returnedCommandNameSet = new Set(returnedCommandNames);
  const missingCommandNames = expectedCommandNames.filter(commandName => false === returnedCommandNameSet.has(commandName));
  const unexpectedCommandNames = returnedCommandNames.filter(commandName => false === expectedCommandNameSet.has(commandName));
  const changedCommandNames = expectedCommandNames.filter(commandName => {
    return true === returnedCommandNameSet.has(commandName)
      && expectedCommandHashes.get(commandName) !== returnedCommandHashes.get(commandName);
  });

  return {
    expectedCommandNames,
    returnedCommandNames,
    missingCommandNames,
    unexpectedCommandNames,
    changedCommandNames,
    truncated: returnedCommandNames.length < expectedCommandNames.length,
  };
}

export function hasSlashRegistrationMismatch(diff: SlashRegistrationDiff): boolean {
  return 0 < diff.missingCommandNames.length
    || 0 < diff.unexpectedCommandNames.length
    || 0 < diff.changedCommandNames.length;
}
