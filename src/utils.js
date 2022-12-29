import chalk from 'chalk';
import cheerio from 'cheerio';
import * as dotenv from 'dotenv';
import fs from 'fs';
import { globbySync } from 'globby';
import { decode, encode } from 'html-entities';
import path from 'path';
import replace from 'replace-in-file';
import shell from 'shelljs';

import {
  androidJava,
  androidManifestXml,
  androidValuesStrings,
  appJson,
  buildPaths,
  getAndroidUpdateBundleIDOptions,
  getAndroidUpdateFilesContentOptions,
  getIosFoldersAndFilesPaths,
  getIosUpdateFilesContentOptions,
  getOtherUpdateFilesContentOptions,
  iosPlist,
  iosXcodeproj,
  packageJson,
} from './paths';

dotenv.config();

const APP_PATH = process.env.DEV_APP_PATH || process.cwd();
const PROMISE_DELAY = 200;
const MAX_NAME_LENGTH = 30;
const NON_LANGUAGE_ALPHANUMERIC_REGEX = /[^\p{L}\p{N}]+/gu;
const MIN_LANGUAGE_ALPHANUMERIC_NAME_LENGTH = 4;
const VALID_BUNDLE_ID_REGEX = /^([a-zA-Z]([a-zA-Z0-9_])*\.)+[a-zA-Z]([a-zA-Z0-9_])*$/u;

const pluralize = (count, noun, suffix = 'es') => `${count} ${noun}${count !== 1 ? suffix : ''}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const toRelativePath = absolutePath => path.relative(APP_PATH, absolutePath);
export const cleanString = str => str.replace(NON_LANGUAGE_ALPHANUMERIC_REGEX, '');
export const bundleIDToPath = bundleID => bundleID.replace(/\./g, '/');
export const decodeXmlEntities = name => decode(name, { level: 'xml' });
export const encodeXmlEntities = name =>
  encode(name, { mode: 'nonAscii', level: 'xml', numeric: 'hexadecimal' });
const androidValuesStringsFullPath = path.join(APP_PATH, androidValuesStrings);

export const validateCreation = () => {
  const iosInfoPlistFullPath = globbySync(path.join(APP_PATH, iosPlist))[0];
  const fileExists =
    fs.existsSync(iosInfoPlistFullPath) && fs.existsSync(androidValuesStringsFullPath);

  if (!fileExists) {
    console.log('Directory should be created using "react-native init".');
    process.exit();
  }
};

export const validateGitRepo = () => {
  shell.cd(APP_PATH);
  const isGitRepository =
    shell.exec('git rev-parse --is-inside-work-tree', { silent: true }).code === 0;

  if (!isGitRepository) {
    console.log('This is not a git repository');
    process.exit();
  }
};

export const checkGitRepoStatus = () => {
  shell.cd(APP_PATH);
  const output = shell.exec('git status', { silent: true }).stdout;
  const isClean = output.includes('nothing to commit, working tree clean');

  if (!isClean) {
    console.log(
      `The directory is not clean. There are changes that have not been committed to the Git repository.
Clean it first and try again or use "--skipGitStatusCheck" option to skip this check.`
    );
    process.exit();
  }
};

export const validateNewName = (newName, programOptions) => {
  if (!(newName.length <= MAX_NAME_LENGTH)) {
    console.log(`New app name "${newName}" is too long`);
    process.exit();
  }

  const cleanNewName = cleanString(newName);
  const isCleanNewNameLengthValid = cleanNewName.length >= MIN_LANGUAGE_ALPHANUMERIC_NAME_LENGTH;
  const hasPathContentStr = !!programOptions.pathContentStr;

  // Ask user to provide a custom path and content string if the cleanNewName is less than MIN_LANGUAGE_ALPHANUMERIC_NAME_LENGTH
  if (!isCleanNewNameLengthValid && !hasPathContentStr) {
    console.log(
      `Please provide path and content string using "-p [value]" or "--pathContentStr [value]" option to be used in renaming the folders, files and their contents.
example: react-native-rename "${newName}" -p "[value]"`
    );
    process.exit();
  }
};

export const validateNewPathContentStr = value => {
  const cleanValue = cleanString(value ?? '');
  const isCleanValueLengthValid = cleanValue.length >= MIN_LANGUAGE_ALPHANUMERIC_NAME_LENGTH;

  if (!isCleanValueLengthValid) {
    console.log(
      'The value provided in --pathContentString or -p option is too short or contains special characters.'
    );
    process.exit();
  }
};

export const validateNewBundleID = newBundleID => {
  if (!VALID_BUNDLE_ID_REGEX.test(newBundleID)) {
    console.log(
      `The bundle identifier "${newBundleID}" is not valid. It should contain only alphanumeric characters and dots, e.g. com.example.app or com.example`
    );
    process.exit();
  }

  const segments = newBundleID.split('.');

  if (segments.length < 2) {
    console.log(
      `The bundle identifier "${newBundleID}" is not valid. It should contain at least 2 segments, e.g. com.example.app or com.example`
    );
    process.exit();
  }
};

const getElementFromXml = ({ filepath, selector }) => {
  const xml = fs.readFileSync(filepath, 'utf8');
  const $ = cheerio.load(xml, { xmlMode: true, decodeEntities: false });

  return $(selector);
};

export const getIosCurrentName = () => {
  const filepath = globbySync(path.join(APP_PATH, iosPlist))[0];
  const selector = 'dict > key:contains("CFBundleDisplayName") + string';
  const element = getElementFromXml({ filepath, selector });

  return decodeXmlEntities(element.text());
};

export const getAndroidCurrentName = () => {
  const selector = 'resources > string[name="app_name"]';
  const element = getElementFromXml({ filepath: androidValuesStringsFullPath, selector });

  return decodeXmlEntities(element.text());
};

export const getAndroidCurrentBundleID = () => {
  const filepath = path.join(APP_PATH, androidManifestXml);
  const selector = 'manifest';
  const element = getElementFromXml({ filepath, selector });

  return element.attr('package');
};

export const getIosXcodeProjectPathName = () => {
  const xcodeProjectPath = globbySync(path.join(APP_PATH, iosXcodeproj), {
    onlyDirectories: true,
  });

  return xcodeProjectPath[0].split('/').pop().replace('.xcodeproj', '');
};

const renameFoldersAndFiles = async ({
  foldersAndFilesPaths,
  currentPath: currentPathParam,
  newPath: newPathParam,
  createNewPathFirst = false,
  shellMoveCurrentPathGlobEnd = '',
}) => {
  const promises = foldersAndFilesPaths.map(async (filePath, index) => {
    await delay(index * PROMISE_DELAY);
    const currentPath = path.join(APP_PATH, filePath);
    const newPath = path.join(APP_PATH, filePath.replace(currentPathParam, newPathParam));

    if (currentPath === newPath) {
      return console.log(toRelativePath(currentPath), chalk.yellow('NOT RENAMED'));
    }

    if (createNewPathFirst) {
      shell.mkdir('-p', newPath);
    }

    try {
      new Promise(resolve => {
        if (!fs.existsSync(currentPath)) {
          return resolve();
        }

        const shellMove = shell.mv('-f', `${currentPath}${shellMoveCurrentPathGlobEnd}`, newPath);

        if (shellMove.code !== 0) {
          console.log(chalk.red(shellMove.stderr));
        }

        resolve();
        console.log(toRelativePath(newPath), chalk.green('RENAMED'));
      });
    } catch (error) {
      console.log(error);
    }
  });

  await Promise.all(promises);
};

export const renameIosFoldersAndFiles = async newPathContentStr => {
  const currentPathContentStr = getIosXcodeProjectPathName();
  const foldersAndFilesPaths = getIosFoldersAndFilesPaths({
    currentPathContentStr,
    newPathContentStr,
  });

  await renameFoldersAndFiles({
    foldersAndFilesPaths,
    currentPath: cleanString(currentPathContentStr),
    newPath: cleanString(newPathContentStr),
  });
};

export const updateFilesContent = async filesContentOptions => {
  const promises = filesContentOptions.map(async (option, index) => {
    await delay(index * PROMISE_DELAY);

    const isOptionFilesString = typeof option.files === 'string';
    const updatedOption = {
      ...option,
      countMatches: true,
      allowEmptyPaths: true,
      files: isOptionFilesString
        ? path.join(APP_PATH, option.files)
        : option.files.map(file => path.join(APP_PATH, file)),
    };

    try {
      const results = await replace(updatedOption);
      results.map(result => {
        const hasChanged = result.hasChanged;
        const message = `${hasChanged ? 'UPDATED' : 'NOT UPDATED'} (${pluralize(
          result.numMatches || 0,
          'match'
        )})`;
        console.log(
          toRelativePath(result.file),
          hasChanged ? chalk.green(message) : chalk.yellow(message)
        );
      });
    } catch (error) {
      const filePath = error.message.replace('No files match the pattern:', '').trim();
      console.log(toRelativePath(filePath), chalk.yellow('NOT FOUND'));
    }
  });

  await Promise.all(promises);
};

export const updateIosFilesContent = async ({
  currentName,
  newName,
  currentPathContentStr,
  newPathContentStr,
  newBundleID,
}) => {
  const filesContentOptions = getIosUpdateFilesContentOptions({
    currentName,
    newName,
    currentPathContentStr,
    newPathContentStr,
    newBundleID,
  });
  await updateFilesContent(filesContentOptions);
};

const updateElementInXml = async ({ filepath, selector, text }) => {
  const $ = cheerio.load(fs.readFileSync(filepath, 'utf8'), {
    xmlMode: true,
    decodeEntities: false,
  });

  const element = $(selector);
  element.text(encodeXmlEntities(text));
  await fs.promises.writeFile(filepath, $.xml());
  console.log(toRelativePath(filepath), chalk.green('UPDATED'));
};

export const updateIosNameInInfoPlist = async newName => {
  await updateElementInXml({
    filepath: globbySync(path.join(APP_PATH, iosPlist))[0],
    selector: 'dict > key:contains("CFBundleDisplayName") + string',
    text: newName,
  });
};

export const updateAndroidNameInStringsXml = async newName => {
  await updateElementInXml({
    filepath: androidValuesStringsFullPath,
    selector: 'resources > string[name="app_name"]',
    text: newName,
  });
};

export const renameAndroidBundleIDFolders = async ({
  currentBundleIDAsPath,
  newBundleIDAsPath,
}) => {
  const currentBundleIDFoldersRelativePaths = globbySync(
    path.join(APP_PATH, `${androidJava}/${currentBundleIDAsPath}`),
    { onlyDirectories: true }
  ).map(folderPath => toRelativePath(folderPath));

  await renameFoldersAndFiles({
    foldersAndFilesPaths: currentBundleIDFoldersRelativePaths,
    currentPath: currentBundleIDAsPath,
    newPath: newBundleIDAsPath,
    createNewPathFirst: true,
    shellMoveCurrentPathGlobEnd: '/*',
  });
};

export const updateAndroidFilesContent = async ({ currentName, newName, newBundleIDAsPath }) => {
  const filesContentOptions = getAndroidUpdateFilesContentOptions({
    currentName,
    newName,
    newBundleIDAsPath,
  });

  await updateFilesContent(filesContentOptions);
};

export const updateAndroidFilesContentBundleID = async ({
  currentBundleID,
  newBundleID,
  currentBundleIDAsPath,
  newBundleIDAsPath,
}) => {
  const filesContentOptions = getAndroidUpdateBundleIDOptions({
    currentBundleID,
    newBundleID,
    currentBundleIDAsPath,
    newBundleIDAsPath,
  });

  await updateFilesContent(filesContentOptions);
};

const getJsonContent = jsonFile => {
  return JSON.parse(fs.readFileSync(path.join(APP_PATH, jsonFile), 'utf8'));
};

export const updateOtherFilesContent = async ({
  newName,
  currentPathContentStr,
  newPathContentStr,
  currentIosName,
  newAndroidBundleID,
  newIosBundleID,
}) => {
  const appJsonContent = getJsonContent(appJson);
  const packageJsonContent = getJsonContent(packageJson);

  const filesContentOptions = getOtherUpdateFilesContentOptions({
    currentName: appJsonContent?.name || currentIosName,
    newName,
    currentPathContentStr,
    newPathContentStr,
    appJsonName: appJsonContent?.name,
    appJsonDisplayName: appJsonContent?.displayName,
    packageJsonName: packageJsonContent?.name,
    newAndroidBundleID,
    newIosBundleID,
  });

  await updateFilesContent(filesContentOptions);
};

export const cleanBuilds = () => {
  shell.rm(
    '-rf',
    buildPaths.map(buildPath => path.join(APP_PATH, buildPath))
  );
  console.log(chalk.yellow('Done removing builds.'));
};

export const showSuccessMessages = newName => {
  const appJsonContent = getJsonContent(appJson);
  const isUsingExpo = !!appJsonContent?.expo;

  console.log(
    `
${chalk.green('SUCCESS! 🎉 🎉 🎉')} Your app has been renamed to "${chalk.yellow(newName)}".
`
  );

  if (isUsingExpo) {
    console.log(
      chalk.yellow(`If you need to update EXUpdatesURL in Expo.plist and EXPO_UPDATE_URL in AndroidManifest.xml, please do so manually.
`)
    );
  }

  console.log(
    chalk.yellow(`- Make sure to check old .xcodeproj and .xcworkspace in ios folder, please delete them manually.
- Please make sure to run "npx pod-install" and "watchman watch-del-all" before running the app.

If you like this tool, please give it a star on GitHub: https://github.com/junedomingo/react-native-rename`)
  );
};

export const gitStageChanges = () => {
  shell.cd(APP_PATH);
  shell.exec('git add .');
};
