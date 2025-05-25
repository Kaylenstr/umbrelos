async mountExternalShare(remotePath: string, mountPath: string, username: string, password: string) {
  await $`mkdir -p ${mountPath}`;
  await $`sudo mount -t cifs "${remotePath}" "${mountPath}" -o username=${username},password=${password},uid=1000,gid=1000`;
}
