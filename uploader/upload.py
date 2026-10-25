"""Direct uploads from a local file; reads FF_UPLOADER_URL and FF_UPLOADER_KEY.
Example: python upload.py inventory rec... photo.jpg receipt.pdf
Requires Python standard library only. No automatic retry after upload failure.
"""
import json, os, pathlib, secrets, sys, urllib.request, urllib.parse, urllib.error

def main():
    if len(sys.argv)<4:
        raise SystemExit('Usage: upload.py TARGET RECORD_ID FILE [FILE ...]')
    target,record,*files=sys.argv[1:]
    url=os.environ['FF_UPLOADER_URL'].rstrip('/')
    if not url.startswith('https://'):
        raise SystemExit('HTTPS uploader URL required')
    key=os.environ['FF_UPLOADER_KEY']
    for name in files:
        path=pathlib.Path(name)
        if not 0<path.stat().st_size<=5_000_000:
            raise SystemExit(f'{path.name}: file must be 1 byte–5 MB')
        boundary=secrets.token_hex(24)
        filename=path.name.replace('"','_').replace('\r','_').replace('\n','_')
        body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+path.read_bytes()+f'\r\n--{boundary}--\r\n'.encode())
        req=urllib.request.Request(url+'/api/upload?'+urllib.parse.urlencode({'target':target,'record':record}),data=body,headers={'Authorization':'Bearer '+key,'Content-Type':'multipart/form-data; boundary='+boundary},method='POST')
        try:
            with urllib.request.urlopen(req,timeout=90) as response:
                result=json.load(response)
        except urllib.error.HTTPError as e:
            raise SystemExit(f'{path.name}: stopped (HTTP {e.code}); check the Airtable record before retrying.')
        except (TimeoutError,urllib.error.URLError):
            raise SystemExit(f'{path.name}: response interrupted; check the Airtable record before retrying.')
        print(path.name+': '+result['status'])

if __name__=='__main__':
    main()
