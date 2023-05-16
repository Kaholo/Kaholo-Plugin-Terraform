const { resolve: resolvePath } = require("path");
const pluginLib = require("@kaholo/plugin-library");

const {
  validateDirectoryPath,
  convertMapToObject,
  generateRandomTemporaryPath,
  saveToRandomTemporaryFile,
  shredTerraformVarFile,
  tryParseTerraformJsonOutput,
  isJsonAllowed,
  getCurrentUserId,
  asyncExec,
} = require("./helpers");

function createTerraformCommand(baseCommand, {
  variableFile,
  json,
  additionalArgs = [],
}) {
  const command = baseCommand.startsWith("terraform ") ? baseCommand.substring(10) : baseCommand;
  const postArgs = [...additionalArgs];
  if (variableFile) {
    postArgs.push("-var-file=$TERRAFORM_VAR_FILE_MOUNT_POINT");
  }
  if (json) {
    if (isJsonAllowed(command)) {
      postArgs.push("-json");
    } else {
      console.error("JSON Output is not supported for this Terraform command.");
    }
  }
  return `${command} ${postArgs.join(" ")}`;
}

async function execute(params) {
  const {
    workingDirectory,
    command,
    variables,
    secretEnvVariables,
    rawOutput,
    additionalArgs,
    customDockerImage,
  } = params;

  const environmentVariables = new Map();
  const absoluteWorkingDirectory = workingDirectory ? resolvePath(workingDirectory) : process.cwd();
  await validateDirectoryPath(absoluteWorkingDirectory);
  environmentVariables.set("TERRAFORM_DIR", absoluteWorkingDirectory);
  environmentVariables.set("TERRAFORM_DIR_MOUNT_POINT", generateRandomTemporaryPath());

  if (variables) {
    const fileName = await saveToRandomTemporaryFile(variables);
    environmentVariables.set("TERRAFORM_VAR_FILE", fileName);
    environmentVariables.set("TERRAFORM_VAR_FILE_MOUNT_POINT", generateRandomTemporaryPath());
  }

  const terraformCommand = createTerraformCommand(command, {
    variableFile: environmentVariables.has("TERRAFORM_VAR_FILE_MOUNT_POINT"),
    json: !rawOutput,
    additionalArgs,
  });

  const dockerEnvs = secretEnvVariables ? pluginLib.parsers.keyValuePairs(secretEnvVariables) : {};

  const buildDockerCommandOptions = {
    image: customDockerImage,
    command: terraformCommand,
    user: await getCurrentUserId(),
    additionalArguments: [
      "-w $TERRAFORM_DIR_MOUNT_POINT",
      "-v $TERRAFORM_DIR:$TERRAFORM_DIR_MOUNT_POINT",
      variables ? "-v $TERRAFORM_VAR_FILE:$TERRAFORM_VAR_FILE_MOUNT_POINT" : "",
    ],
  };

  if (dockerEnvs) {
    buildDockerCommandOptions.environmentVariables = dockerEnvs;
  }

  const dockerCommand = pluginLib.docker.buildDockerCommand(buildDockerCommandOptions);

  const {
    stdout,
    stderr,
    error,
  } = await asyncExec({
    command: dockerCommand,
    onProgressFn: process.stdout.write.bind(process.stdout),
    options: {
      env: {
        ...convertMapToObject(environmentVariables),
        ...dockerEnvs,
      },
    },
  });

  if (environmentVariables.has("TERRAFORM_VAR_FILE")) {
    await shredTerraformVarFile(environmentVariables.get("TERRAFORM_VAR_FILE"));
  }

  if (error) {
    if (!rawOutput) {
      console.error("\nRECOMMENDATION: Try enabling parameter Raw Output for a more meaningful error message.\n");
    }
    throw new Error(error);
  }

  if (stderr && !stdout) {
    throw new Error(stderr);
  } else if (stderr) {
    console.error(stderr);
  }

  if (rawOutput) {
    return "";
  }
  const parsedStdout = tryParseTerraformJsonOutput(stdout);
  return parsedStdout;
}

module.exports = {
  execute,
};
