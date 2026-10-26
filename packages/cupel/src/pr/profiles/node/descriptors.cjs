const fs = require('node:fs');
const {emit,deny,relative,root,within} = require('./policy.cjs');
const {invocationOrigin} = require('./provenance.cjs');
const descriptors = new Map();
const writeFlags = flags => typeof flags === 'string' ? /[wa+]/.test(flags) :
  !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT |
    fs.constants.O_TRUNC | fs.constants.O_APPEND));
const opened = (fd,path) => { descriptors.set(fd,path); };
const use = (fd,operation) => {
  const origin=invocationOrigin();
  if (fd === 1 || fd === 2) return;
  const path = descriptors.get(fd);
  if (!path) deny('unknown-descriptor',`${operation}:${fd}`);
  emit({kind:operation,channel:'reads',file:within(root,path)?relative(path):path,origin});
};
const closed = fd => descriptors.delete(fd);
module.exports = {opened,use,closed,writeFlags,descriptors};
