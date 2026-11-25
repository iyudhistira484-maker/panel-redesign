package checksum_test

import (
 "archive/tar"
 "bytes"
 "compress/gzip"
 "crypto/sha256"
 "io"
 "mime/multipart"
 "testing"
)

// Model the destination extraction boundary with Go's real multipart/TAR readers.
func TestChecksumCoversRemainder(t *testing.T) {
 var archive bytes.Buffer
 gz := gzip.NewWriter(&archive)
 tw := tar.NewWriter(gz)
 if err := tw.WriteHeader(&tar.Header{Name:"fixture", Mode:0600, Size:1}); err != nil { t.Fatal(err) }
 if _, err := tw.Write([]byte{42}); err != nil { t.Fatal(err) }
 if err := tw.Close(); err != nil { t.Fatal(err) }
 if err := gz.Close(); err != nil { t.Fatal(err) }
 // Legal concatenated gzip members after TAR EOF. Ensure multipart/gzip
 // buffering cannot fetch the entire tail before the extractor returns.
 for i:=0; i<300; i++ {
  member := gzip.NewWriter(&archive)
  if err := member.Close(); err != nil { t.Fatal(err) }
 }
 payload := archive.Bytes()
 expected := sha256.Sum256(payload)
 check := func(data []byte, drain bool) bool {
  var form bytes.Buffer
  fw:=multipart.NewWriter(&form)
  part,err:=fw.CreateFormFile("archive","archive.tar.gz"); if err!=nil {t.Fatal(err)}
  if _,err=part.Write(data);err!=nil {t.Fatal(err)}
  if err=fw.Close();err!=nil {t.Fatal(err)}
  p,err:=multipart.NewReader(&form,fw.Boundary()).NextPart();if err!=nil {t.Fatal(err)}
  h:=sha256.New();tee:=io.TeeReader(p,h)
  zr,err:=gzip.NewReader(tee);if err!=nil {t.Fatal(err)}
  tr:=tar.NewReader(zr)
  if _,err=tr.Next();err!=nil {t.Fatal(err)}
  if _,err=tr.Next();err!=io.EOF {t.Fatalf("want TAR EOF, got %v",err)}
  if err=zr.Close();err!=nil {t.Fatal(err)}
  if drain {if _,err=io.Copy(io.Discard,tee);err!=nil {t.Fatal(err)}}
  return bytes.Equal(h.Sum(nil),expected[:])
 }
 if check(payload,false) {t.Fatal("fixture did not reproduce partial hashing")}
 if !check(payload,true) {t.Fatal("complete archive did not match")}
 changed:=append([]byte(nil),payload...)
 changed[len(changed)-1]^=1
 if check(changed,true) {t.Fatal("corrupted archive matched")}
}
