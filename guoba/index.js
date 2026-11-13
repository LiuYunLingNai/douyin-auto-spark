import pluginInfo from './pluginInfo.js'
import configInfo from './configInfo.js'
import { installTemplateExtension } from './template-extension.js'

export function supportGuoba() {
  installTemplateExtension()
  return { pluginInfo, configInfo }
}
