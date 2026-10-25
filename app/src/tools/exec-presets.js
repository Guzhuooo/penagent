import { fail } from '../core/errors.js';
import { allowedProbeUrl } from '../core/config.js';
import { validateSchema } from '../core/schema.js';
export function quotePosix(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
export function buildExecPreset(args, hosts) {
  validateSchema(args, {
    type: 'object', properties: {
      commandId: { type: 'string', enum: ['head_probe', 'system_arch', 'device_time'] },
      params: { type: 'object', properties: { url: { type: 'string', maxLength: 2048 } }, additionalProperties: false }
    }, required: ['commandId', 'params'], additionalProperties: false
  });
  let executable;
  let argv;
  let params;
  if (args.commandId === 'head_probe') {
    validateSchema(args.params, { type: 'object', properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['url'], additionalProperties: false });
    params = { url: allowedProbeUrl(args.params.url, hosts) };
    executable = 'curl';
    argv = ['-f', '-s', '-I', '--max-time', '6', '--output', '/dev/null', '--', params.url];
  } else if (args.commandId === 'system_arch' || args.commandId === 'device_time') {
    validateSchema(args.params, { type: 'object', properties: {}, additionalProperties: false });
    params = {};
    executable = args.commandId === 'system_arch' ? 'uname' : 'date';
    argv = args.commandId === 'system_arch' ? ['-m'] : ['+%Y-%m-%dT%H:%M:%S%z'];
  } else fail('ARGUMENT_ERROR');
  return {
    commandId: args.commandId, params: params, executable: executable, argv: argv,
    shell: [executable].concat(argv).map(quotePosix).join(' '), timeout: 6000
  };
}
