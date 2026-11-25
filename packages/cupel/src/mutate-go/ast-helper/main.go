package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"strings"
)

type request struct {
	Source string `json:"source"`
	Text   string `json:"text"`
}

type site struct {
	Line        int    `json:"line"`
	Column      int    `json:"column"`
	Start       int    `json:"start"`
	End         int    `json:"end"`
	Operator    string `json:"operator"`
	Original    string `json:"original"`
	Replacement string `json:"replacement"`
}

type span struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type functionFact struct {
	Start       int      `json:"start"`
	BodyStart   int      `json:"bodyStart"`
	BodyEnd     int      `json:"bodyEnd"`
	Results     bool     `json:"results"`
	Generic     bool     `json:"generic"`
	Receivers   []string `json:"receivers"`
	Parameters  []string `json:"parameters"`
	ResultNames []string `json:"resultNames"`
	Redeclare   bool     `json:"redeclare"`
	Reason      string   `json:"reason,omitempty"`
}

type response struct {
	Sites      []site         `json:"sites"`
	Functions  []functionFact `json:"functions"`
	Literals   []span         `json:"literals"`
	FileReason string         `json:"fileReason,omitempty"`
	Error      string         `json:"error,omitempty"`
}

var buildConstraint = regexp.MustCompile(`(?m)^[\t ]*//(?:go:build|[\t ]*\+build)\b`)

func offset(fset *token.FileSet, pos token.Pos) int { return fset.Position(pos).Offset }

func fieldNames(fields *ast.FieldList) []string {
	names := make([]string, 0)
	if fields == nil {
		return names
	}
	for _, field := range fields.List {
		for _, name := range field.Names {
			if name.Name != "_" {
				names = append(names, name.Name)
			}
		}
	}
	return names
}

func directive(text string) bool {
	text = strings.TrimSpace(text)
	return strings.HasPrefix(text, "//go:") || text == "//line" || strings.HasPrefix(text, "//line ") ||
		strings.HasPrefix(text, "/*go:") || text == "/*line*/" || strings.HasPrefix(text, "/*line ")
}

func functionReason(file *ast.File, decl *ast.FuncDecl, fset *token.FileSet, text string) string {
	for _, group := range file.Comments {
		for _, comment := range group.List {
			if !directive(comment.Text) {
				continue
			}
			start, end := offset(fset, comment.Pos()), offset(fset, comment.End())
			if start >= offset(fset, decl.Body.Lbrace) && end <= offset(fset, decl.Body.Rbrace) {
				return "directive"
			}
			if end <= offset(fset, decl.Pos()) && strings.TrimSpace(text[end:offset(fset, decl.Pos())]) == "" {
				return "directive"
			}
		}
	}
	reason := ""
	ast.Inspect(decl.Body, func(node ast.Node) bool {
		if reason != "" {
			return false
		}
		switch n := node.(type) {
		case *ast.BranchStmt:
			if n.Tok == token.GOTO {
				reason = "label"
			}
		case *ast.LabeledStmt:
			reason = "label"
		case *ast.BasicLit:
			if n.Kind == token.STRING && strings.HasPrefix(n.Value, "`") && strings.ContainsAny(n.Value, "\r\n") {
				reason = "multiline-raw"
			}
		case *ast.CallExpr:
			if ident, ok := n.Fun.(*ast.Ident); ok {
				if ident.Name == "recover" && len(n.Args) == 0 {
					reason = "recover"
				} else if ident.Name == "panic" {
					reason = "position"
				}
			}
		}
		return reason == ""
	})
	return reason
}

func redeclares(decl *ast.FuncDecl, names []string) bool {
	wanted := make(map[string]bool, len(names))
	for _, name := range names {
		wanted[name] = true
	}
	found := false
	ast.Inspect(decl.Body, func(node ast.Node) bool {
		if found {
			return false
		}
		assign, ok := node.(*ast.AssignStmt)
		if !ok || assign.Tok != token.DEFINE {
			return true
		}
		for _, lhs := range assign.Lhs {
			if ident, ok := lhs.(*ast.Ident); ok && wanted[ident.Name] {
				found = true
				return false
			}
		}
		return true
	})
	return found
}

func sourceFacts(file *ast.File, fset *token.FileSet, text string) ([]functionFact, []span, string) {
	functions := make([]functionFact, 0)
	literals := make([]span, 0)
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		receivers := fieldNames(fn.Recv)
		parameters := fieldNames(fn.Type.Params)
		resultNames := fieldNames(fn.Type.Results)
		names := append(append(append([]string{}, receivers...), parameters...), resultNames...)
		functions = append(functions, functionFact{
			Start: offset(fset, fn.Pos()), BodyStart: offset(fset, fn.Body.Lbrace), BodyEnd: offset(fset, fn.Body.Rbrace),
			Results: fn.Type.Results != nil && len(fn.Type.Results.List) > 0, Generic: fn.Type.TypeParams != nil,
			Receivers: receivers, Parameters: parameters, ResultNames: resultNames,
			Redeclare: redeclares(fn, names), Reason: functionReason(file, fn, fset, text),
		})
	}
	ast.Inspect(file, func(node ast.Node) bool {
		if literal, ok := node.(*ast.FuncLit); ok && literal.Body != nil {
			literals = append(literals, span{Start: offset(fset, literal.Pos()), End: offset(fset, literal.End())})
		}
		return true
	})
	if buildConstraint.MatchString(text) {
		return functions, literals, "build-tag"
	}
	for _, spec := range file.Imports {
		if spec.Path.Value == `"C"` {
			return functions, literals, "cgo"
		}
	}
	fileReason := ""
	ast.Inspect(file, func(node ast.Node) bool {
		if fileReason != "" {
			return false
		}
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		switch selector.Sel.Name {
		case "Helper", "Caller", "Callers", "CallersFrames", "FuncForPC", "Stack":
			fileReason = "position"
		}
		return fileReason == ""
	})
	return functions, literals, fileReason
}

func replacement(op token.Token) (string, string) {
	switch op {
	case token.EQL:
		return "cmp-flip", "!="
	case token.NEQ:
		return "cmp-flip", "=="
	case token.LSS:
		return "cmp-flip", ">="
	case token.LEQ:
		return "cmp-flip", ">"
	case token.GTR:
		return "cmp-flip", "<="
	case token.GEQ:
		return "cmp-flip", "<"
	case token.LAND:
		return "logical", "||"
	case token.LOR:
		return "logical", "&&"
	case token.ADD:
		return "arith", "-"
	case token.SUB:
		return "arith", "+"
	default:
		return "", ""
	}
}

func main() {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		json.NewEncoder(os.Stdout).Encode(response{Error: err.Error()})
		return
	}
	fset := token.NewFileSet()
	// functionReason needs directive comments. ParseComments only adds comment
	// nodes; the site and declaration walks below continue to ignore them.
	file, err := parser.ParseFile(fset, req.Source, req.Text, parser.AllErrors|parser.ParseComments)
	if err != nil {
		json.NewEncoder(os.Stdout).Encode(response{Error: err.Error()})
		return
	}
	functions, literals, fileReason := sourceFacts(file, fset, req.Text)
	sites := make([]site, 0)
	add := func(pos token.Pos, original, next, operator string) {
		p := fset.Position(pos)
		sites = append(sites, site{Line: p.Line, Column: p.Column, Start: p.Offset,
			End: p.Offset + len(original), Operator: operator, Original: original, Replacement: next})
	}
	ast.Inspect(file, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.BinaryExpr:
			if operator, next := replacement(n.Op); operator != "" {
				add(n.OpPos, n.Op.String(), next, operator)
			}
		case *ast.Ident:
			if n.Obj == nil && (n.Name == "true" || n.Name == "false") {
				next := "true"
				if n.Name == "true" {
					next = "false"
				}
				add(n.Pos(), n.Name, next, "bool-literal")
			}
		}
		return true
	})
	json.NewEncoder(os.Stdout).Encode(response{Sites: sites, Functions: functions, Literals: literals, FileReason: fileReason})
}
