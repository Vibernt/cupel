package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
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

type response struct {
	Sites []site `json:"sites"`
	Error string `json:"error,omitempty"`
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
	file, err := parser.ParseFile(fset, req.Source, req.Text, parser.AllErrors)
	if err != nil {
		json.NewEncoder(os.Stdout).Encode(response{Error: err.Error()})
		return
	}
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
	json.NewEncoder(os.Stdout).Encode(response{Sites: sites})
}
