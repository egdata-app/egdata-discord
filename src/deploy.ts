import { REST, Routes } from 'discord.js';
import { clientId, token } from './config.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commands: any[] = [];
const commandsFolder = path.join(__dirname, 'commands');

const commandFiles = fs
  .readdirSync(commandsFolder)
  .filter((file) => file.endsWith('.ts'));

for (const file of commandFiles) {
  const commandPath = path.join(commandsFolder, file);

  const command = await import(`file://${commandPath}`).then(
    (module) => module.default
  );

  if (
    'data' in command &&
    ('execute' in command || 'autocomplete' in command)
  ) {
    const data = command.data.toJSON();
    commands.push({
      ...data,
      integration_types: [0, 1],
      contexts: [0, 1, 2],
    });
  } else {
    console.error(`Error loading command ${file}`);
  }
}

const rest = new REST().setToken(token);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(Routes.applicationCommands(clientId), { body: commands });

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();
