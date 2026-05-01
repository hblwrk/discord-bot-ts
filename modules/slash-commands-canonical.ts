/* eslint-disable import/extensions */
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

function toCanonicalSlashCommandChoice(choice: unknown): CanonicalSlashCommandChoice {
  if ("object" !== typeof choice || null === choice) {
    return {
      name: "",
      value: "",
    };
  }

  return {
    name: "string" === typeof (choice as any).name ? (choice as any).name : "",
    value: (choice as any).value,
  };
}

function toCanonicalSlashCommandOption(option: unknown): CanonicalSlashCommandOption {
  if ("object" !== typeof option || null === option) {
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

  const rawOption = option as any;
  const canonicalOption: CanonicalSlashCommandOption = {
    type: Number(rawOption.type ?? 0),
    name: "string" === typeof rawOption.name ? rawOption.name : "",
    description: "string" === typeof rawOption.description ? rawOption.description : "",
    required: true === rawOption.required,
    autocomplete: true === rawOption.autocomplete,
    channel_types: Array.isArray(rawOption.channel_types)
      ? rawOption.channel_types.map((channelType: unknown) => Number(channelType))
      : [],
    choices: Array.isArray(rawOption.choices)
      ? rawOption.choices.map(toCanonicalSlashCommandChoice)
      : [],
    options: Array.isArray(rawOption.options)
      ? rawOption.options.map(toCanonicalSlashCommandOption)
      : [],
  };

  if ("number" === typeof rawOption.min_value) {
    canonicalOption.min_value = rawOption.min_value;
  }

  if ("number" === typeof rawOption.max_value) {
    canonicalOption.max_value = rawOption.max_value;
  }

  if ("number" === typeof rawOption.min_length) {
    canonicalOption.min_length = rawOption.min_length;
  }

  if ("number" === typeof rawOption.max_length) {
    canonicalOption.max_length = rawOption.max_length;
  }

  return canonicalOption;
}

function toCanonicalSlashCommand(command: unknown): CanonicalSlashCommand {
  if ("object" !== typeof command || null === command) {
    return {
      type: 1,
      name: "",
      description: "",
      options: [],
    };
  }

  const rawCommand = command as any;
  return {
    type: Number(rawCommand.type ?? 1),
    name: "string" === typeof rawCommand.name ? rawCommand.name : "",
    description: "string" === typeof rawCommand.description ? rawCommand.description : "",
    options: Array.isArray(rawCommand.options)
      ? rawCommand.options.map(toCanonicalSlashCommandOption)
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
